var log = require('logger')('pot');
var nconf = require('nconf').argv().env();
var util = require('util');
var path = require('path');
var async = require('async');
var express = require('express');
var mongoose = require('mongoose');
var should = require('should');
var Redis = require('ioredis');
var request = require('request');
var _ = require('lodash');
var fs = require('fs');
var bodyParser = require('body-parser');

mongoose.Promise = global.Promise;

var env = nconf.get('ENV');

nconf.defaults(require('./env/' + env + '.json'));

var redis = new Redis(nconf.get('REDIS_URI'));

var errors = require('errors');
var initializers = require('initializers');
var server = require('server');

var mockPort = 6060;
var mock;

var client;

var admin;

var limits;

var createUsers = function (o, numUsers, done) {
  async.whilst(function () {
    return numUsers-- > 0;
  }, function (iterated) {
    var email = 'user' + numUsers + '@serandives.com';
    var password = exports.password();
    var user = {};
    request({
      uri: exports.resolve('accounts', '/apis/v/users'),
      method: 'POST',
      headers: {
        'X-Captcha': 'dummy'
      },
      json: {
        email: email,
        password: password,
        alias: 'user' + numUsers
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
        headers: {
          'X-Captcha': 'dummy'
        },
        form: {
          client_id: o.serandivesId,
          grant_type: 'password',
          username: email,
          password: password,
          redirect_uri: exports.resolve('accounts', '/auth')
        },
        json: true
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
    var password = exports.password();
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

var mocks = function (done) {
  var app = express();
  app.use(bodyParser.json());
  fs.readdir(path.join(__dirname, 'mocks'), function (err, files) {
    if (err) {
      return done(err);
    }
    async.eachSeries(files, function (file, eachDone) {
      var route = require('./mocks/' + file);
      route(app, eachDone);
    }, function (err) {
      if (err) {
        return done(err);
      }
      mock = app.listen(mockPort, function (err) {
        if (err) {
          return done(err);
        }
        log.info('mock:started', 'port:%s', mockPort);
        done();
      });
    });
  });
};

exports.start = function (done) {
  mocks(function (err) {
    if (err) {
      return done(err);
    }
    server.install(function (err) {
      if (err) {
        return done(err);
      }
      redis.flushall(function (err) {
        if (err) {
          return done(err);
        }
        var mongodbUri = nconf.get('MONGODB_URI');
        mongoose.connect(mongodbUri);
        var db = mongoose.connection;
        db.on('error', function (err) {
          log.error('db:errored', err);
        });
        db.once('open', function () {
          log.info('db:opened', 'uri:%s', mongodbUri);
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
      });
    });
  });
};

exports.stop = function (done) {
  server.stop(function (err) {
    if (err) {
      return done(err);
    }
    mongoose.disconnect(function (err) {
      if (err) {
        return done(err);
      }
      if (!mock) {
        return done()
      }
      mock.close(done);
    });
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
  var prefix = (env === 'test' || env === 'travis') ? env : env + '.' + domain;
  return 'http://' + prefix + '.serandives.com:' + nconf.get('PORT') + path;
};

exports.clone = function (o) {
  var clone = _.cloneDeep(o);
  delete clone.user;
  delete clone.permissions;
  delete clone.id;
  return clone;
};

exports.password = function () {
  return '1@2.Com';
};

exports.client = function (done) {
  if (client) {
    return done(null, client);
  }
  var numUsers = 3;
  client = {users: []};
  request({
    uri: exports.resolve('accounts', '/apis/v/configs'),
    method: 'GET',
    qs: {
      data: JSON.stringify({
        query: {
          name: 'boot'
        }
      })
    },
    json: true
  }, function (e, r, b) {
    if (e) {
      return done(e);
    }
    if (r.statusCode !== 200) {
      return done(new Error(r.statusCode));
    }
    if (!b.length) {
      return done(new Error('!b.length'));
    }
    var boot = b[0];
    if (boot.name !== 'boot') {
      return done(new Error('boot.name !== \'boot\''));
    }
    client.serandivesId = boot.value.clients.serandives;
    createUsers(client, numUsers, function (err) {
      if (err) {
        return done(err);
      }
      exports.admin(function (err, admin) {
        if (err) {
          return done(err);
        }
        client.admin = admin;
        exports.unthrottle(function (err) {
          if (err) {
            return done(err);
          }
          done(null, client);
        });
      });
    });
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
      headers: {
        'X-Captcha': 'dummy'
      },
      form: {
        client_id: client.serandivesId,
        grant_type: 'password',
        username: 'admin@serandives.com',
        password: nconf.get('PASSWORD'),
        redirect_uri: exports.resolve('accounts', '/auth')
      },
      json: true
    }, function (e, r, token) {
      if (e) {
        return done(e);
      }
      if (r.statusCode !== 200) {
        return done(new Error(r.statusCode));
      }
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
          admin.token = accessToken;
          admin.profile = user;
          done(null, admin);
        });
      });
    });
  });
};

exports.groups = function (done) {
  request({
    uri: exports.resolve('accounts', '/apis/v/configs'),
    method: 'GET',
    qs: {
      data: JSON.stringify({
        query: {
          name: 'groups'
        }
      })
    },
    json: true
  }, function (e, r, b) {
    if (e) {
      return done(e);
    }
    if (r.statusCode !== 200) {
      return done(new Error(r.statusCode));
    }
    if (!b.length) {
      return done(new Error('!b.length'));
    }
    var groupz = b[0];
    if (groupz.name !== 'groups') {
      return done(new Error('groups.name !== \'groups\''));
    }
    var groups = {};
    groupz.value.forEach(function (group) {
      groups[group.name] = group;
    });
    done(null, groups);
  })
};

var backupLimits = function (done) {
  if (limits) {
    return done();
  }
  mongoose.model('tiers').find({}, function (err, tiers) {
    if (err) {
      return done(err);
    }
    var o = {};
    tiers.forEach(function (tier) {
      o[tier.name] = {
        apis: tier.apis,
        ips: tier.ips
      };
    });
    limits = o;
    done();
  });
};

exports.unthrottle = function (done) {
  mongoose.model('tiers').update({name: {$in: ['free', 'basic']}}, {
    apis: {
      vehicles: {
        find: {
          second: Number.MAX_VALUE,
          day: Number.MAX_VALUE,
          month: Number.MAX_VALUE
        },
        create: {
          second: Number.MAX_VALUE,
          day: Number.MAX_VALUE,
          month: Number.MAX_VALUE
        }
      }
    },
    ips: {
      find: {
        second: Number.MAX_VALUE,
        minute: Number.MAX_VALUE,
        hour: Number.MAX_VALUE,
        day: Number.MAX_VALUE
      },
      create: {
        second: Number.MAX_VALUE,
        minute: Number.MAX_VALUE,
        hour: Number.MAX_VALUE,
        day: Number.MAX_VALUE
      }
    }
  }, {multi: true}, done);
};

exports.throttle = function (tiers, done) {
  if (!done) {
    done = tiers;
    tiers = {};
  }
  backupLimits(function (err) {
    if (err) {
      return done(err);
    }
    async.each(Object.keys(tiers), function (name, updated) {
      var o = tiers[name];
      mongoose.model('tiers').update({name: name}, {
        apis: o.apis,
        ips: o.ips
      }, updated);
    }, function (err) {
      if (err) {
        return done(err);
      }
      redis.flushall(done);
    });
  });
};

exports.throttlit = function (name, model) {
  var byMethod = {
    find: {
      GET: function (i) {
        return exports.resolve(name, '/apis/v/' + model + (i % 2 === 0 ? '' : '/' + 'dummy'))
      },
      HEAD: function (i) {
        return exports.resolve(name, '/apis/v/' + model + (i % 2 === 0 ? '' : '/' + 'dummy'))
      }
    },
    create: {
      POST: function (i) {
        return exports.resolve(name, '/apis/v/' + model)
      }
    },
    update: {
      PUT: function (i) {
        return exports.resolve(name, '/apis/v/' + model + '/dummy')
      }
    },
    remove: {
      DELETE: function (i) {
        return exports.resolve(name, '/apis/v/' + model + '/dummy')
      }
    }
  };

  var suite = 'throttle ' + model;

  var define = function (suite, tier, limits) {
    describe(suite, function () {

      before(exports.client);

      after(exports.unthrottle);

      var methods = ['find', 'create', 'update', 'remove'];

      methods.forEach(function (method) {
        var uris = byMethod[method];
        var vk = Object.keys(uris);
        var vl = vk.length;
        var durations = limits[method] || limits['*'];
        Object.keys(durations).forEach(function (duration) {
          it(util.format('%s tier apis %s for %s', 'free', method, duration), function (itDone) {
            var byMethod = {};
            byMethod[duration] = limits[method][duration];
            var byModel = {};
            byModel[method] = byMethod;
            var byAPI = {};
            byAPI[model] = byModel;

            var o = {};

            o[tier] = {
              apis: byAPI,
              ips: byModel
            };

            exports.throttle(o, function (err) {
              if (err) {
                return itDone(err);
              }
              var limit = durations[duration];
              var allowed = 0;
              var blocked = 0;
              async.times(limit + 1, function (i, timesDone) {
                var verb = vk[i % vl];
                var uri = uris[verb];
                var options = {
                  uri: uri(i),
                  method: verb
                };
                if (verb !== 'HEAD') {
                  options.json = {};
                }
                if (tier === 'basic') {
                  options.auth = {
                    bearer: client.users[0].token
                  }
                }
                request(options, function (e, r, b) {
                  if (e) {
                    return timesDone(e);
                  }
                  r.statusCode === errors.tooManyRequests().status ? blocked++ : allowed++;
                  timesDone();
                });
              }, function (err) {
                if (err) {
                  return itDone(err);
                }
                blocked.should.equal(1);
                allowed.should.equal(limit);
                itDone();
              });
            });
          });
        });
      });
    });
  }

  describe('throttle', function () {

    define(model + ' apis', 'basic', {
      find: {
        second: 0,
        day: 1,
        month: 2
      },
      create: {
        second: 0,
        day: 1,
        month: 2
      },
      update: {
        second: 0,
        day: 1,
        month: 2
      },
      remove: {
        second: 0,
        day: 1,
        month: 2
      }
    });

    define(model + ' ips', 'free', {
      find: {
        second: 0,
        minute: 1,
        hour: 2,
        day: 3
      },
      create: {
        second: 0,
        minute: 1,
        hour: 2,
        day: 3
      },
      update: {
        second: 0,
        minute: 1,
        hour: 2,
        day: 3
      },
      remove: {
        second: 0,
        minute: 1,
        hour: 2,
        day: 3
      }
    });
  });
};