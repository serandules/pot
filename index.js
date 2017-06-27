var log = require('logger')('pot');
var nconf = require('nconf').argv().env();
var async = require('async');
var mongoose = require('mongoose');
var request = require('request');
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

exports.start = function (don) {
    var done = function (err) {
        if (err) {
            log.error(err);
        }
        don(err);
    };
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

exports.resolve = function (domain, path) {
    var prefix = env === 'test' ? env : env + '.' + domain;
    return 'http://' + prefix + '.serandives.com:4000' + path;
};

exports.client = function (done) {
    var o = {users: []};
    var numUsers = 2;
    request({
        uri: exports.resolve('accounts', '/apis/v/configs/boot'),
        method: 'GET',
        json: true
    }, function (e, r, b) {
        if (e) {
            return done(e);
        }
        if (r.statusCode !== 200) {
            return done(new Error(r.statusCode))
        }
        o.serandivesId = b.value.clients.serandives;
        async.whilst(function () {
            return numUsers-- > 0;
        }, function (iterated) {
            var email = 'user' + numUsers + '@serandives.com';
            var password = '1@2.Com';
            var user = {};
            request({
                uri: exports.resolve('accounts', '/apis/v/users'),
                method: 'POST',
                json: {
                    email: email,
                    password: password
                }
            }, function (e, r, b) {
                if (e) {
                    return iterated(e);
                }
                if (r.statusCode !== 201) {
                    return iterated(new Error(r.statusCode))
                }
                user.profile = b;
                request({
                    uri: exports.resolve('accounts', '/apis/v/tokens'),
                    method: 'POST',
                    json: {
                        client_id: o.serandivesId,
                        grant_type: 'password',
                        username: email,
                        password: password
                    }
                }, function (e, r, b) {
                    if (e) {
                        return iterated(e);
                    }
                    if (r.statusCode !== 200) {
                        return iterated(new Error(r.statusCode))
                    }
                    user.token = b.access_token;
                    o.users.push(user);
                    iterated();
                });
            });
        }, function (err) {
            done(err, o);
        });
    })
}