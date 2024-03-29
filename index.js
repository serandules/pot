var log = require('logger')('pot');
var nconf = require('nconf');
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

var cdn = require('cdn');

mongoose.Promise = global.Promise;

var redis = new Redis(nconf.get('REDIS_URI'));

var errors = require('errors');

var mockPort = 6060;
var cdnPort = 4040;
var mock;

var client;

var admin;

var limits;

exports.confirmEmail = function (sera, user, done) {
  sera.model('otps').findOne({
    user: user.id,
    name: 'accounts-confirm'
  }, function (err, otp) {
    if (err) {
      return done(err);
    }
    request({
      uri: exports.resolve('apis', '/v/users/' + user.id),
      method: 'POST',
      headers: {
        'X-OTP': otp.strong,
        'X-Action': 'confirm'
      },
      json: {}
    }, function (e, r, b) {
      if (e) {
        return done(e);
      }
      if (r.statusCode !== 204) {
        return done(new Error(r.statusCode));
      }
      done();
    });
  });
};

exports.createUser = function (sera, clientId, usr, done) {
  request({
    uri: exports.resolve('apis', '/v/users'),
    method: 'POST',
    headers: {
      'X-Captcha': 'dummy'
    },
    json: usr
  }, function (e, r, user) {
    if (e) {
      return done(e);
    }
    if (r.statusCode !== 201) {
      return done(new Error(r.statusCode));
    }
    should.exist(user.id);
    should.exist(user.email);
    user.email.should.equal(usr.email);
    exports.confirmEmail(sera, user, function (err) {
      if (err) {
        return done(err);
      }
      request({
        uri: exports.resolve('apis', '/v/tokens'),
        method: 'POST',
        headers: {
          'X-Captcha': 'dummy'
        },
        form: {
          client_id: clientId,
          grant_type: 'password',
          username: usr.email,
          password: usr.password,
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
        should.exist(token.access_token);
        should.exist(token.refresh_token);
        done(null, user, token);
      });
    });
  });
};

var createUsers = function (sera, o, numUsers, done) {
  async.whilst(function () {
    return numUsers-- > 0;
  }, function (iterated) {
    var email = 'user' + numUsers + '@serandives.com';
    var password = exports.password();
    var user = {};
    exports.createUser(sera, o.serandivesId, {
      email: email,
      password: password,
      username: 'user' + numUsers
    }, function (err, usr, token) {
      if (err) {
        return iterated(err);
      }
      user.profile = usr;
      user.token = token.access_token;
      o.users.push(user);
      iterated();
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
      uri: exports.resolve('apis', '/v/tokens'),
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
        uri: exports.resolve('apis', '/v/tokens/' + b.id),
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
          uri: exports.resolve('apis', '/v/users/' + b.user),
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
  cdn.start(cdnPort, function (err) {
    if (err) {
      return done(err);
    }
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
  });
};

exports.start = function (done) {
  mocks(function (err) {
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
          }, done);
        });
      });
    });
  });
};

exports.stop = function (destroy, done) {
  destroy(function (err) {
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
  var env = nconf.get('ENV');
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

exports.client = function (sera, done) {
  if (client) {
    return done(null, client);
  }
  var numUsers = 4;
  client = {users: []};
  request({
    uri: exports.resolve('apis', '/v/configs'),
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
    client.serandivesId = boot.value.clients.serandives.id;
    createUsers(sera, client, numUsers, function (err) {
      if (err) {
        return done(err);
      }
      exports.admin(sera, function (err, admin) {
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

exports.admin = function (sera, done) {
  if (admin) {
    return done(null, admin);
  }
  admin = {};
  exports.client(sera, function (err, client) {
    if (err) {
      return done(err);
    }
    request({
      uri: exports.resolve('apis', '/v/tokens'),
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
        uri: exports.resolve('apis', '/v/tokens/' + token.id),
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
          uri: exports.resolve('apis', '/v/users/' + b.user),
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
    uri: exports.resolve('apis', '/v/configs'),
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

exports.throttlit = function (sera, name, model, tiers, actions) {
  var byMethod = {
    find: {
      GET: function (i) {
        return {
          url: exports.resolve(name, '/v/' + model + (i % 2 === 0 ? '' : '/' + 'dummy'))
        }
      },
      HEAD: function (i) {
        return {
          url: exports.resolve(name, '/v/' + model + (i % 2 === 0 ? '' : '/' + 'dummy'))
        }
      }
    },
    create: {
      POST: function (i) {
        return {
          url: exports.resolve(name, '/v/' + model)
        }
      }
    },
    update: {
      PUT: function (i) {
        return {
          url: exports.resolve(name, '/v/' + model + '/dummy')
        }
      }
    },
    remove: {
      DELETE: function (i) {
        return {
          url: exports.resolve(name, '/v/' + model + '/dummy')
        }
      }
    }
  };

  byMethod = {}
  _.merge(byMethod, actions || {});

  var define = function (suite, tier, limits) {
    describe(suite, function () {

      before(function (done) {
        exports.client(sera, done);
      });

      after(exports.unthrottle);

      Object.keys(byMethod).forEach(function (method) {
        var oo = byMethod[method];
        var vk = Object.keys(oo);
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
                var opts = oo[verb];
                var options = _.merge(opts(i), {
                  method: verb
                });
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

    define(model + ' apis', 'basic', _.merge({
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
    }, tiers && tiers.apis || {}));

    define(model + ' ips', 'free', _.merge({
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
    }, tiers && tiers.ips || {}));
  });
};

exports.transit = function (model, id, user, action, done) {
  request({
    uri: exports.resolve('apis', '/v/' + model + '/' + id),
    method: 'POST',
    headers: {
      'X-Action': 'transit'
    },
    auth: {
      bearer: user
    },
    json: {
      action: action
    }
  }, function (e, r, b) {
    if (e) {
      return done(e);
    }
    r.statusCode.should.equal(204);
    done();
  });
};

exports.traverse = function (model, id, user, actions, done) {
  async.whilst(function () {
    return actions.length;
  }, function (whilstDone) {
    var action = actions.shift();
    exports.transit(model, id, user, action, whilstDone);
  }, done);
};

exports.publish = function (model, id, owner, reviewer, done) {
  exports.transit(model, id, owner, 'review', function (err) {
    if (err) {
      return done(err);
    }
    exports.transit(model, id, reviewer, 'approve', function (err) {
      if (err) {
        return done(err);
      }
      exports.transit(model, id, owner, 'publish', done);
    });
  });
};
