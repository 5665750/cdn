var AWS = require('aws-sdk');
var Promise = require('bluebird');
var stream = require('stream');
var _ = require('underscore');

var logger = require('@dadi/logger');
var config = require(__dirname + '/../../../config');

var S3Storage = function (settings, url) {
  var self = this;

  AWS.config.setPromisesDependency(require('bluebird'));
  AWS.config.update({ accessKeyId: settings.s3.accessKey, secretAccessKey: settings.s3.secretKey });

  if (settings.s3.region && settings.s3.region != "") {
    AWS.config.update({ region: settings.s3.region });
  }

  this.url = url;
  this.s3 = new AWS.S3();

  this.getBucket = function() {
    if (self.url.indexOf('s3') > 0) {
      return _.compact(self.urlParts())[0]
    }
    else {
      return settings.s3.bucketName
    }
  }

  this.getKey = function() {
    if (self.url.indexOf('s3') > 0) {
      var parts = _.compact(self.urlParts())
      parts.shift()
      return parts.join('/')
    }
    else {
      return self.url
    }
  }

  this.urlParts = function() {
    return self.url.replace('/s3', '').split('/')
  }
}

S3Storage.prototype.get = function () {
  var self = this;

  return new Promise(function(resolve, reject) {
    var requestData = {
      Bucket: self.getBucket(),
      Key: self.getKey()
    }

    logger.info('S3 Request (' + self.url + '):' + JSON.stringify(requestData))

    if (requestData.Bucket === '' || requestData.Key === '' ) {
      var err = {
        statusCode: 400,
        message: 'Either no Bucket or Key provided: ' + JSON.stringify(requestData)
      }
      return reject(err)
    }

    // create the AWS.Request object
    var request = self.s3.getObject(requestData);

    var promise = request.promise();

    promise.then(
      function (data) {
        var bufferStream = new stream.PassThrough();
        bufferStream.push(data.Body)
        bufferStream.push(null)
        resolve(bufferStream);
      },
      function (error) {
        reject(error);
      }
    )
  })
}

module.exports = function (settings, url) {
  return new S3Storage(settings, url);
}

module.exports.S3Storage = S3Storage