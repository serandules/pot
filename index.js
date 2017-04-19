var log = require('logger')('pot');
var nconf = require('nconf').argv().env();
var async = require('async');
var mongoose = require('mongoose');
var initializers = require('initializers');
var server = require('server');

var initialized = false;

mongoose.Promise = global.Promise;

var env = nconf.get('env');

nconf.defaults(require('./env/' + env + '.json'));

var start = function (done) {
    var mongodbUri = nconf.get('mongodbUri');
    mongoose.connect(mongodbUri);
    var db = mongoose.connection;
    db.on('error', function (err) {
        log.error('mongodb connection error: %e', err);
    });
    db.once('open', function () {
        log.info('connected to mongodb : ' + mongodbUri);
        mongoose.connection.db.dropDatabase(function (err) {
            if (err) {
                return done(err);
            }
            initializers.init(function (err) {
                if (err) {
                    return done(err);
                }
                server.start(done);
            });
        });
    });
};

exports.start = function (done) {
    if (initialized) {
        return start(done);
    }
    server.init(function (err) {
        if (err) {
            return done(err);
        }
        initialized = true;
        start(done);
    });
};

exports.stop = function (done) {
    server.stop(function () {
        mongoose.disconnect(done);
    });
};

exports.resolve = function (path) {
    return 'http://test.serandives.com:4000' + path;
};