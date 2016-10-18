var fs = require('fs')
var concat = require('concat-stream')
var ColorThief = require('color-thief')
var colorThief = new ColorThief()
var ExifImage = require('exif').ExifImage
// var fill = require('aspect-fill')
var fit = require('aspect-fit')
var imagesize = require('imagesize')
var lengthStream = require('length-stream')
// var logger = require('@dadi/logger')
var PassThrough = require('stream').PassThrough
var path = require('path')
var Promise = require('bluebird')
var Readable = require('stream').Readable
var sha1 = require('sha1')
// var smartcrop = require('smartcrop-lwip')
var url = require('url')
var _ = require('underscore')

var StorageFactory = require(path.join(__dirname, '/../storage/factory'))
var Cache = require(path.join(__dirname, '/../cache'))
var config = require(path.join(__dirname, '/../../../config'))

var GRAVITY_TYPES = {
  NW: 'northwest',
  N: 'north',
  NE: 'northeast',
  W: 'west',
  C: 'center',
  E: 'east',
  SW: 'southwest',
  S: 'south',
  SE: 'southeast',
  NONE: 'none'
}

/**
 * Performs checks on the supplied URL and fetches the image
 * @param {String} format - the type of image requested
 * @param {Object} req - the original HTTP request
 */
var ImageHandler = function (format, req) {
  this.req = req
  this.storageFactory = Object.create(StorageFactory)
  this.storageHandler = null
  this.cache = Cache()

  var parsedUrl = url.parse(this.req.url, true)
  this.url = req.url
  this.cacheKey = this.req.url
  this.fileName = path.basename(parsedUrl.pathname)
  this.fileExt = path.extname(this.fileName).substring(1)
  this.exifData = {}
}

ImageHandler.prototype.put = function (stream, folderPath) {
  return new Promise((resolve, reject) => {
    this.storageHandler = this.storageFactory.create('image', this.url)

    this.storageHandler.put(stream, folderPath).then((result) => {
      return resolve(result)
    })
  })
}

ImageHandler.prototype.get = function () {
  var self = this
  self.cached = false

  var parsedUrl = url.parse(this.req.url, true)

  // get the image options provided as querystring or path
  if (parsedUrl.search) {
    // get image options from the querystring
    this.options = parsedUrl.query
  } else if (!this.options) {
    // get the segments of the url that relate to image manipulation options
    var urlSegments = _.filter(parsedUrl.pathname.split('/'), function (segment, index) {
      if (index > 0 && segment === '') return '0'
      if (index < 13 || (index >= 13 && /^[0-1]$/.test(segment))) {
        return segment
      }
    })

    this.options = getImageOptions(urlSegments)
  }

  // clean the options array up
  this.options = self.sanitiseOptions(this.options)

  if (typeof this.options.format === 'undefined') this.options.format = this.fileExt

  if (this.options.format === 'json') {
    if (this.fileExt === this.fileName) {
      this.format = 'PNG'
    } else {
      this.format = this.fileExt
    }
  } else {
    this.format = this.options.format
  }

  return new Promise(function (resolve, reject) {
    var message

    // TODO: is there an error to raise here?
    if (message) {
      var err = {
        statusCode: 400,
        message: message
      }

      return reject(err)
    }

    // get from cache
    self.cache.getStream(self.cacheKey, function (stream) {
      // if found in cache, return it
      if (stream) {
        if (self.options.format !== 'json') {
          self.cached = true
          return resolve(stream)
        }
      }

      // not in cache, get image from source
      self.storageHandler = self.storageFactory.create('image', self.url)

      self.storageHandler.get().then(function (stream) {
        var cacheStream = new PassThrough()
        var convertStream = new PassThrough()
        var imageSizeStream = new PassThrough()
        var responseStream = new PassThrough()
        var exifStream = new PassThrough()

        // duplicate the stream so we can use it for the imagesize() request and the
        // response. this saves requesting the same data a second time.
        stream.pipe(imageSizeStream)
        stream.pipe(convertStream)

        // pipe the stream to a temporary file to avoid back pressure buildup
        // while we wait for the exif data to be processed
        var tmpExifFile
        if (self.options.format === 'json') {
          tmpExifFile = path.join(path.resolve(path.join(__dirname, '/../../../workspace')), sha1(self.url))
          stream.pipe(exifStream).pipe(fs.createWriteStream(tmpExifFile))
        }

        // get the image size and format
        imagesize(imageSizeStream, function (err, imageInfo) {
          if (err && err !== 'invalid') {
            console.log(err)
          }

          // extract exif data if available
          if (imageInfo && /jpe?g/.exec(imageInfo.format) && self.options.format === 'json') {
            self.extractExifData(tmpExifFile).then(function (exifData) {
              self.exifData = exifData
            }).catch(function (err) {
              // no exif data
              if (err) console.log(err)
            })
          }

          if (tmpExifFile) {
            // remove the temporary exifData file
            try {
              fs.unlinkSync(tmpExifFile)
            } catch (err) {
              console.log(err)
            }
          }

          // connvert image using specified options
          self.convert(convertStream, imageInfo).then(function (result) {
            var convertedStream = result.stream
            var dataFromConvert = result.data || {}

            convertedStream.pipe(cacheStream)
            convertedStream.pipe(responseStream)

            // cache the file if enabled
            self.cache.cacheFile(cacheStream, self.cacheKey, function () {
              // return image info only, as json
              if (self.options.format === 'json') {
                self.getImageInfo(convertedStream, imageInfo, function (data) {
                  // Adding data from `convert()` to response
                  data = _.extendOwn(data, dataFromConvert)

                  var returnStream = new Readable()
                  returnStream.push(JSON.stringify(data, null, 2))
                  returnStream.push(null)

                  return resolve(returnStream)
                })
              } else {
                // return image
                return resolve(responseStream)
              }
            })
          }).catch(function (err) {
            return reject(err)
          })
        })
      }).catch(function (err) {
        return reject(err)
      })
    })
  })
}

/**
 * Convert image according to options specified
 * @param {stream} stream - read stream from S3, local disk or url
 */
ImageHandler.prototype.convert = function (stream, imageInfo) {
  var self = this
  var options = self.options

  var dimensions = getDimensions(options, imageInfo)
  var width = parseInt(dimensions.width)
  var height = parseInt(dimensions.height)

  return new Promise(function (resolve, reject) {
    if (options.cropX && options.cropY) {
      var originalWidth = parseFloat(imageInfo.width)
      var originalHeight = parseFloat(imageInfo.height)

      // console.log("%s > %s || %s > %s", width,(originalWidth-parseInt(options.cropX)), height, (originalHeight-parseInt(options.cropY)))
      if ((width - parseInt(options.cropX) > originalWidth) || (height - parseInt(options.cropY)) > originalHeight) {
        var rectangle = width.toString() + 'x' + height.toString()
        var original = originalWidth.toString() + 'x' + originalHeight.toString()
        var message = 'The calculated crop rectangle is larger than the original image size. Crop rectangle: ' + rectangle + ', Image size: ' + original
        var err = {
          statusCode: 400,
          message: message
        }

        return reject(err)
      }
    }

    var concatStream = concat(processImage)
    stream.pipe(concatStream)

    function processImage (imageBuffer) {
      // obtain an image object
      require('lwip').open(imageBuffer, imageInfo.format, function (err, image) {
        if (err) return reject(err)

        var shouldExtractEntropy = ((options.resizeStyle === 'entropy') && width && height) ? self.extractEntropy(image, width, height) : false

        Promise.resolve(shouldExtractEntropy).then((entropy) => {
          // define a batch of manipulations
          var batch = image.batch()

          var filter = options.filter ? options.filter.toLowerCase() : 'lanczos'

          // resize
          if (options.resizeStyle) {
            if (width && height) {
              switch (options.resizeStyle) {
                /*
                Aspect Fit: Will size your image until the whole image fits within your area.
                You are left with the extra space on top and bottom.
                */
                case 'aspectfit':
                  var size = fit(imageInfo.width, imageInfo.height, width, height)
                  batch.cover(parseInt(size.width), parseInt(size.height), filter)
                  break
                /*
                Aspect Fill: Will size your image proportionally until the whole area is full of your image.
                Your image is clipped. It will size proportionally to make sure there is no blank space left in your area.
                */
                case 'aspectfill':
                  var scaleWidth = (width / parseInt(imageInfo.width))
                  var scaleHeight = (height / parseInt(imageInfo.height))
                  var scale = Math.max(scaleWidth, scaleHeight)
                  var crops = self.getCropOffsetsByGravity(options.gravity, imageInfo, dimensions, scale)

                  batch.scale(scale)

                  // Only crop if the aspect ratio is not the same
                  // if ((width / height) !== (imageInfo.width / imageInfo.height) && !self.storageHandler.notFound) {
                  //   batch.crop(crops.x1, crops.y1, crops.x2, crops.y2)
                  // }
                  if ((width / height) !== (imageInfo.width / imageInfo.height)) {
                    batch.crop(crops.x1, crops.y1, crops.x2, crops.y2)
                  }

                  break
                case 'fill':
                  batch.resize(width, height, filter)
                  break
                case 'crop':
                  if (options.crop) {
                    var coords = options.crop.split(',').map((coordStr) => {
                      return parseInt(coordStr)
                    })

                    // Reduce 1 pixel on the edges
                    coords[2] = (coords[2] > 0) ? (coords[2] - 1) : coords[2]
                    coords[3] = (coords[3] > 0) ? (coords[3] - 1) : coords[3]

                    if (coords.length === 2) {
                      batch.crop(coords[0], coords[1], width - coords[0], height - coords[1])
                    } else if (coords.length === 4) {
                      // image.crop(left, top, right, bottom, callback)
                      batch.crop(coords[0], coords[1], coords[2], coords[3])

                      if (width && height) {
                        batch.resize(width, height, filter)
                      }
                    }
                  } else { // width & height provided, crop from centre
                    batch.crop(width, height)
                  }

                  break
                case 'entropy':
                  if (entropy) {
                    // Reduce 1 pixel on the edges
                    entropy.x2 = (entropy.x2 > 0) ? (entropy.x2 - 1) : entropy.x2
                    entropy.y2 = (entropy.y2 > 0) ? (entropy.y2 - 1) : entropy.y2

                    batch.crop(entropy.x1, entropy.y1, entropy.x2 - 1, entropy.y2 - 1)
                    batch.resize(width, height)
                  }
              }
            }
          } else if (width && height && options.cropX && options.cropY) {
            // console.log("%s %s %s %s", parseInt(options.cropX), parseInt(options.cropY), width-parseInt(options.cropX), height-parseInt(options.cropY))
            batch.crop(parseInt(options.cropX), parseInt(options.cropY), width - parseInt(options.cropX), height - parseInt(options.cropY))
          } else if (width && height) {
            batch.cover(width, height)
          } else if (width && !height) {
            batch.resize(width)
          }

          if (options.blur) batch.blur(parseInt(options.blur))
          if (options.flip) batch.flip(options.flip)
          if (options.rotate) batch.rotate(parseInt(options.rotate), 'white')

          // quality
          var params = {}
          var quality = parseInt(options.quality)

          if (/jpe?g/.exec(imageInfo.format)) params.quality = quality

          if (/png/.exec(imageInfo.format)) {
            if (quality > 70) params.compression = 'none'
            else if (quality > 50) params.compression = 'fast'
            else params.compression = 'high'
          }

          // sharpening
          if (options.sharpen !== 5) {
            batch.sharpen(options.sharpen)
          } else if (quality >= 70) {
            if (/jpe?g/.exec(imageInfo.format)) {
              batch.sharpen(5)
            } else if (/png/.exec(imageInfo.format)) {
              batch.sharpen(5)
            } else if (options.cropX && options.cropY) {
              batch.sharpen(5)
            }
          }

          // give it a little colour
          batch.saturate(options.saturate)

          // format
          var format = (self.options.format === 'json' ? imageInfo.format : self.options.format).toLowerCase()

          try {
            batch.exec(function (err, image) {
              if (err) console.log(err)

              image.toBuffer(format, params, function (err, buffer) {
                if (err) return reject(err)

                var bufferStream = new PassThrough()
                bufferStream.end(buffer)

                var additionalData = {}

                if (entropy) {
                  additionalData.entropyCrop = entropy
                }

                return resolve({stream: bufferStream, data: additionalData})
              })
            })
          } catch (err) {
            return reject(err)
          }
        })
      })
    }
  })
}

/**
 *
 */
ImageHandler.prototype.getCropOffsetsByGravity = function (gravity, originalDimensions, croppedDimensions, scale) {
  var originalWidth = parseInt(originalDimensions.width)
  var originalHeight = parseInt(originalDimensions.height)

  var croppedWidth = parseInt(croppedDimensions.width)
  var croppedHeight = parseInt(croppedDimensions.height)

  if (!scale) scale = croppedWidth / originalWidth
  var resizedWidth = originalWidth * scale
  var resizedHeight = originalHeight * scale

  // No vertical offset for northern gravity
  var verticalOffset = 0
  var horizontalOffset = 0

  switch (gravity.toLowerCase()) {
    case GRAVITY_TYPES.NW:
    case GRAVITY_TYPES.N:
    case GRAVITY_TYPES.NE:
      verticalOffset = 0
      break
    case GRAVITY_TYPES.C:
    case GRAVITY_TYPES.E:
    case GRAVITY_TYPES.W:
      verticalOffset = getMaxOfArray([(resizedHeight - croppedHeight) / 2.0, 0])
      break
    case GRAVITY_TYPES.SW:
    case GRAVITY_TYPES.S:
    case GRAVITY_TYPES.SE:
      verticalOffset = resizedHeight - croppedHeight
      break
    default:
      verticalOffset = 0
  }

  switch (gravity) {
    case GRAVITY_TYPES.NW:
    case GRAVITY_TYPES.W:
    case GRAVITY_TYPES.SW:
      horizontalOffset = 0
      break
    case GRAVITY_TYPES.C:
    case GRAVITY_TYPES.N:
    case GRAVITY_TYPES.S:
      horizontalOffset = getMaxOfArray([(resizedWidth - croppedWidth) / 2.0, 0])
      break
    case GRAVITY_TYPES.NE:
    case GRAVITY_TYPES.E:
    case GRAVITY_TYPES.SE:
      horizontalOffset = resizedWidth - croppedWidth
      break
    default:
      horizontalOffset = 0
  }

  function getMaxOfArray (numArray) {
    return Math.max.apply(null, numArray)
  }

  return {
    x1: Math.floor(horizontalOffset),
    x2: Math.floor(horizontalOffset + croppedWidth) - 1,
    y1: Math.floor(verticalOffset),
    y2: Math.floor(verticalOffset + croppedHeight) - 1
  }
}

/**
 * Extract coordinates for a crop based on the entropy of the image
 * @param {image} image - LWIP image instance
 * @param {number} width - Crop width
 * @param {number} heifgt - Crop height
 */
ImageHandler.prototype.extractEntropy = function (image, width, height) {
  return new Promise((resolve, reject) => {
    image.clone((err, clone) => {
      if (err) return reject(err)

      return resolve(require('smartcrop-lwip').crop(null, {
        width: width,
        height: height,
        image: {
          width: clone.width(),
          height: clone.height(),
          _lwip: clone
        }
      }).then((result) => {
        return {
          x1: result.topCrop.x,
          x2: result.topCrop.x + result.topCrop.width,
          y1: result.topCrop.y,
          y2: result.topCrop.y + result.topCrop.height
        }
      }))
    })
  })
}

/**
 * Extract EXIF data from the specified image
 * @param {stream} stream - read stream from S3, local disk or url
 */
ImageHandler.prototype.extractExifData = function (file) {
  return new Promise(function (resolve, reject) {
    var concatStream = concat(gotImage)
    fs.createReadStream(file).pipe(concatStream)

    function gotImage (buffer) {
      ExifImage({ image: buffer }, function (err, data) {
        if (err) {
          return reject(err)
        } else {
          return resolve(data)
        }
      })
    }
  })
}

/**
 * Get image information from stream
 * @param {stream} stream - read stream from S3, local disk or url
 * @returns {object}
 */

/*
{ "fileName":"322324f3696ec76c3479617aa2d700403e58b74c.jpg", "cacheReference":"24a33b40b0c2281cb045d6dff9139a5a0ec0baff",
  "fileSize":20766, "format":"JPEG", "width":"520", "height":"346", "depth":8,
  "density":{"width":72,"height":72}, "exif":{"orientation":0}, "primaryColor":"#b7b7b0",
  "quality":"70", "trim":0, "trimFuzz":0, "resizeStyle":"aspectfill", "gravity":"Center",
  "filter":"None", "blur":0, "strip":0, "rotate":0, "flip":0, "ratio":0, "devicePixelRatio":0
}
*/
ImageHandler.prototype.getImageInfo = function (stream, imageInfo, cb) {
  var self = this
  var options = self.options
  var buffers = []
  var fileSize = 0

  function lengthListener (length) {
    fileSize = length
  }

  var data = {
    fileName: self.fileName,
    cacheReference: sha1(self.fileName),
    quality: options.quality ? options.quality : 75,
    trim: options.trim ? options.trim : 0,
    trimFuzz: options.trimFuzz ? options.trimFuzz : 0,
    resizeStyle: options.resizeStyle ? options.resizeStyle : 'aspectfill',
    gravity: options.gravity ? options.gravity : 'Center',
    filter: options.filter ? options.filter : 'None',
    blur: options.blur ? options.blur : 0,
    strip: options.strip ? options.strip : 0,
    rotate: options.rotate ? options.rotate : 0,
    flip: options.flip ? options.flip : 0,
    ratio: options.ratio ? options.ratio : 0,
    devicePixelRatio: options.devicePixelRatio ? options.devicePixelRatio : 0
  }

  var ls = lengthStream(lengthListener)
  stream.pipe(ls)
    .on('error', function (err) { console.log(err) })
    .on('data', function (data) { buffers.push(data) })
    .on('end', function () {
      var buffer = Buffer.concat(buffers)
      var colour = colorThief.getColor(buffer)
      var primaryColour = RGBtoHex(colour[0], colour[1], colour[2])
      var palette = colorThief.getPalette(buffer, options.colours ? options.colours : 6)
      var paletteHex = _.map(palette, function (colour) {
        return RGBtoHex(colour[0], colour[1], colour[2])
      })

      data.format = imageInfo.format
      data.fileSize = fileSize
      data.primaryColor = primaryColour
      data.palette = {
        rgb: palette,
        hex: paletteHex
      }

      if (self.exifData.image && self.exifData.image.XResolution && self.exifData.image.YResolution) {
        data.density = {
          width: self.exifData.image.XResolution,
          height: self.exifData.image.YResolution,
          unit: (self.exifData.image.ResolutionUnit ? (self.exifData.image.ResolutionUnit === 2 ? 'dpi' : '') : '')
        }
      }

      return cb(data)
    })
}

/**
 *
 */
function RGBtoHex (red, green, blue) {
  return '#' + ('00000' + (red << 16 | green << 8 | blue).toString(16)).slice(-6)
}

function getDimensions (options, imageInfo) {
  var dimensions = {
    width: options.width,
    height: options.height
  }

  if (options.ratio) {
    var ratio = options.ratio.split('-')
    if (!dimensions.width && parseFloat(dimensions.height) > 0) {
      dimensions.width = parseFloat(dimensions.height) * (parseFloat(ratio[0]) / parseFloat(ratio[1]))
      dimensions.height = parseFloat(dimensions.height)
    } else if (!dimensions.height && parseFloat(dimensions.width) > 0) {
      dimensions.height = parseFloat(dimensions.width) * (parseFloat(ratio[1]) / parseFloat(ratio[0]))
      dimensions.width = parseFloat(dimensions.width)
    } else if (!dimensions.height && !dimensions.height) {
      dimensions.width = parseFloat(imageInfo.height) * (parseFloat(ratio[0]) / parseFloat(ratio[1]))
      dimensions.height = parseFloat(imageInfo.width) * (parseFloat(ratio[1]) / parseFloat(ratio[0]))
    }
  } else {
    console.log(imageInfo)
    console.log(dimensions)
    if (imageInfo) {
      dimensions.width = imageInfo.width
      dimensions.height = imageInfo.height
    }
  }

  if (config.get('security.maxWidth') && config.get('security.maxWidth') < dimensions.width) {
    dimensions.width = config.get('security.maxWidth')
  }

  if (config.get('security.maxHeight') && config.get('security.maxHeight') < dimensions.height) {
    dimensions.height = config.get('security.maxHeight')
  }

  if (options.devicePixelRatio && options.devicePixelRatio < 4) {
    // http://devicepixelratio.com/
    dimensions.width = parseFloat(dimensions.width) * parseFloat(options.devicePixelRatio)
    dimensions.height = parseFloat(dimensions.height) * parseFloat(options.devicePixelRatio)
  }

  return dimensions
}

/**
 * Parses the request URL and returns an options object
 * @param {Array} optionsArray - the options specified in the request URL
 * @returns {object}
 */
function getImageOptions (optionsArray) {
  var legacyURLFormat = optionsArray.length < 17

  var gravity = optionsArray[optionsArray.length - 6].substring(0, 1).toUpperCase() + optionsArray[optionsArray.length - 6].substring(1)
  var filter = optionsArray[optionsArray.length - 5].substring(0, 1).toUpperCase() + optionsArray[optionsArray.length - 5].substring(1)

  var options = {
    format: optionsArray[0],
    quality: optionsArray[1],
    trim: optionsArray[2],
    trimFuzz: optionsArray[3],
    width: optionsArray[4],
    height: optionsArray[5],

    /* legacy client applications don't send the next 4 */
    cropX: legacyURLFormat ? '0' : optionsArray[6],
    cropY: legacyURLFormat ? '0' : optionsArray[7],
    ratio: legacyURLFormat ? '0' : optionsArray[8],
    devicePixelRatio: legacyURLFormat ? 1 : optionsArray[9],

    resizeStyle: optionsArray[optionsArray.length - 7],
    gravity: gravity,
    filter: filter,
    blur: optionsArray[optionsArray.length - 4],
    strip: optionsArray[optionsArray.length - 3],
    rotate: optionsArray[optionsArray.length - 2],
    flip: optionsArray[optionsArray.length - 1]
  }

  return options
}

ImageHandler.prototype.sanitiseOptions = function (options) {
  // check the options for aliases
  // e.g. "dpr" === "devicePixelRatio"

  var optionSettings = [
    { name: 'format', aliases: ['fmt'] },
    { name: 'quality', aliases: ['q'], default: 75 },
    { name: 'sharpen', aliases: ['sh'], default: 5 },
    { name: 'saturate', aliases: ['sat'], default: 0.1 },
    { name: 'width', aliases: ['w'] },
    { name: 'height', aliases: ['h'] },
    { name: 'ratio', aliases: ['rx'] },
    { name: 'cropX', aliases: ['cx'] },
    { name: 'cropY', aliases: ['cy'] },
    { name: 'crop', aliases: ['coords'] },
    { name: 'resizeStyle', aliases: ['resize'], default: 'aspectfill' },
    { name: 'devicePixelRatio', aliases: ['dpr'] },
    { name: 'gravity', aliases: ['g'], default: 'None' },
    { name: 'filter', aliases: ['f'], default: 'lanczos', lowercase: true },
    { name: 'trim', aliases: ['t'] },
    { name: 'trimFuzz', aliases: ['tf'] },
    { name: 'blur', aliases: ['b'] },
    { name: 'strip', aliases: ['s'] },
    { name: 'rotate', aliases: ['r'] },
    { name: 'flip', aliases: ['fl'] }
  ]

  var imageOptions = {}

  _.each(Object.keys(options), function (key) {
    var settings = _.filter(optionSettings, function (setting) {
      return setting.name === key || _.contains(setting.aliases, key)
    })

    if (settings && settings[0]) {
      if (options[key] !== '0' || settings[0].default) {
        if (options[key] !== '0') {
          var value = options[key]
          if (settings[0].lowercase) value = value.toLowerCase()
          imageOptions[settings[0].name] = _.isFinite(value) ? parseFloat(value) : value
        } else {
          imageOptions[settings[0].name] = settings[0].default
        }
      }
    }
  })

  // ensure we have defaults for options not specified
  var defaults = _.filter(optionSettings, function (setting) {
    return setting.default
  })

  _.each(defaults, function (setting) {
    if (!imageOptions[setting.name]) {
      imageOptions[setting.name] = setting.default
    }
  })

  return imageOptions
}

ImageHandler.prototype.contentType = function () {
  if (this.options.format === 'json') {
    return 'application/json'
  }

  switch (this.format.toLowerCase()) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    default:
      return 'image/jpeg'
  }
}

ImageHandler.prototype.getFilename = function () {
  return this.fileName
}

ImageHandler.prototype.getLastModified = function () {
  if (!this.storageHandler || !this.storageHandler.getLastModified) return null

  return this.storageHandler.getLastModified()
}

module.exports = function (format, req) {
  return new ImageHandler(format, req)
}

module.exports.ImageHandler = ImageHandler
