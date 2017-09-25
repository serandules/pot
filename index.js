var log = require('logger')('pot');
var nconf = require('nconf').argv().env();
var async = require('async');
var mongoose = require('mongoose');
var request = require('request');

var env = nconf.get('env');

nconf.defaults(require('./env/' + env + '.json'));

var initializers = require('initializers');
var server = require('server');

var client;

var admin;

mongoose.Promise = global.Promise;

var start = function (done) {
    var mongodbUri = nconf.get('mongodbUri');
    mongoose.connect(mongodbUri, {useMongoClient: true});
    var db = mongoose.connection;
    db.on('error', function (err) {
        log.error('mongodb connection error: %e', err);
    });
    db.once('open', function () {
        log.info('connected to mongodb : ' + mongodbUri);
        mongoose.connection.db.collections(function (err, collections) {
            if (err) {
                return done(err);
            }
            async.eachLimit(collections, 1, function (collection, removed) {
                collection.remove(removed);
            }, function (err) {
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
    });
};

var createUsers = function (o, numUsers, done) {
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
                return iterated(new Error(r.statusCode));
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
                    return iterated(new Error(r.statusCode));
                }
                user.token = b.access_token;
                o.users.push(user);
                iterated();
            });
        });
    }, function (err) {
        done(err, o);
    });
};

var findUsers = function (o, numUsers, done) {
    async.whilst(function () {
        return numUsers-- > 0;
    }, function (iterated) {
        var email = 'user' + numUsers + '@serandives.com';
        var password = '1@2.Com';
        var user = {};
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
                return iterated(new Error(r.statusCode));
            }
            user.token = b.access_token;
            request({
                uri: exports.resolve('accounts', '/apis/v/tokens/' + b.id),
                method: 'GET',
                auth: {
                    bearer: user.token
                },
                json: true
            }, function (e, r, b) {
                if (e) {
                    return iterated(e);
                }
                if (r.statusCode !== 200) {
                    return iterated(new Error(r.statusCode));
                }
                request({
                    uri: exports.resolve('accounts', '/apis/v/users/' + b.user),
                    method: 'GET',
                    auth: {
                        bearer: user.token
                    },
                    json: true
                }, function (e, r, b) {
                    if (e) {
                        return iterated(e);
                    }
                    if (r.statusCode !== 200) {
                        return iterated(new Error(r.statusCode));
                    }
                    user.profile = b;
                    o.users.push(user);
                    iterated();
                });
            });
        });
    }, function (err) {
        done(err, o);
    });
};

exports.start = function (done) {
    server.init(function (err) {
        if (err) {
            return done(err);
        }
        start(done);
    });
};

exports.stop = function (done) {
    server.stop(function () {
        mongoose.disconnect(done);
    });
};

exports.drop = function (drop, done) {
    drop = Array.isArray(drop) ? drop : [drop];
    mongoose.connection.db.collections(function (err, collections) {
        if (err) {
            return done(err);
        }
        async.eachLimit(collections, 1, function (collection, removed) {
            if (drop.indexOf(collection.collectionName) === -1) {
                return removed();
            }

            collection.remove(removed);
        }, done);
    });
};

exports.resolve = function (domain, path) {
    var prefix = env === 'test' ? env : env + '.' + domain;
    return 'http://' + prefix + '.serandives.com:4000' + path;
};

exports.client = function (done) {
    if (client) {
        return done(null, client);
    }
    var numUsers = 3;
    client = {users: []};
    request({
        uri: exports.resolve('accounts', '/apis/v/configs/boot'),
        method: 'GET',
        json: true
    }, function (e, r, b) {
        if (e) {
            return done(e);
        }
        if (r.statusCode !== 200) {
            return done(new Error(r.statusCode));
        }
        client.serandivesId = b.value.clients.serandives;
        createUsers(client, numUsers, done);
    });
};

exports.admin = function (done) {
    if (admin) {
        return done(null, admin);
    }
    admin = {};
    exports.client(function (err, client) {
        if (err) {
            return done(err);
        }
        request({
            uri: exports.resolve('accounts', '/apis/v/tokens'),
            method: 'POST',
            json: {
                client_id: client.serandivesId,
                grant_type: 'password',
                username: 'admin@serandives.com',
                password: nconf.get('password')
            }
        }, function (e, r, token) {
            if (e) {
                return done(e);
            }
            if (r.statusCode !== 200) {
                return done(new Error(r.statusCode));
            }
            admin.token = token;
            var accessToken = token.access_token;
            request({
                uri: exports.resolve('accounts', '/apis/v/tokens/' + token.id),
                method: 'GET',
                auth: {
                    bearer: accessToken
                },
                json: true
            }, function (e, r, b) {
                if (e) {
                    return done(e);
                }
                if (r.statusCode !== 200) {
                    return done(new Error(r.statusCode));
                }
                request({
                    uri: exports.resolve('accounts', '/apis/v/users/' + b.user),
                    method: 'GET',
                    auth: {
                        bearer: accessToken
                    },
                    json: true
                }, function (e, r, user) {
                    if (e) {
                        return done(e);
                    }
                    if (r.statusCode !== 200) {
                        return done(new Error(r.statusCode));
                    }
                    admin.profile = user;
                    done(null, admin);
                });
            });
        });
    });
};

exports.groups = function (done) {
    request({
        uri: exports.resolve('accounts', '/apis/v/configs/groups'),
        method: 'GET',
        json: true
    }, function (e, r, b) {
        if (e) {
            return done(e);
        }
        if (r.statusCode !== 200) {
            return done(new Error(r.statusCode));
        }
        var groups = {};
        b.value.forEach(function (group) {
            groups[group.name] = group;
        });
        done(null, groups);
    })
};