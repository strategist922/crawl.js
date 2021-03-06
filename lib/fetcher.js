
var request = require('request')
  , fs = require('fs')
  , stream = require('stream')
  , util = require('util')
  , log = require('./logger')
  , conf = require('./config')()
  , Store = require('./store')
  , Extractor = require('./extractor');


function Fetcher (name) {

  this.name = name;

  //every fetcher has its own extractor & store
  this.store = Store.get(name);
  this.extractor = Extractor.get(name, Fetcher.dispatcher);

  //response data is streamed to us
  stream.Stream.call(this);
  this.writable = true;
  this._buffer = [];

}

util.inherits(Fetcher, stream.Stream);

/*
 * Rolling counter indicating which instance is next
 */
Fetcher.next = 0;
Fetcher.active = 0; //how many instances are currently active/busy.
Fetcher.instances = [];

/*
 * check if the fetcher is busy.
 * when he is busy it means that the max. number of concurrent connections
 * is reached.
 */
Fetcher.isBusy = function () {
  return Fetcher.active >= Fetcher.instances.length;
};

Fetcher.isActive = function () {
  return Fetcher.active > 0;
};

/*
 * Get an `url`.
 * The actual fetching is done by one of the Fetchers instance.
 * Dispatching to the responible instance is done with Rount-robin
 */
Fetcher.get = function (url, cb) {
  Fetcher.active++;
  Fetcher.instances[Fetcher.next++].get(url, function () {
    Fetcher.active--;
    cb.apply(this, arguments);
  });
  if (Fetcher.next >= Fetcher.instances.length) {
    Fetcher.next = 0;
  }
};

Fetcher.init = function (dispatcher) {
  
  Fetcher.requestOptions = conf.fetcher.request;
  Fetcher.poolSize = conf.fetcher.poolSize;
  Fetcher.wait = conf.fetcher.wait;

  Fetcher.dispatcher = dispatcher;
  Fetcher.instances = [];

  for (var i = 0; i < Fetcher.poolSize; i++) {
    Fetcher.instances.push(new Fetcher('fetcher-' + i));
  }

};

/*
 * Stream interface
 */
Fetcher.prototype.write = function (chunk) {
  this._buffer.push(chunk);
};

Fetcher.prototype.end = function (chunk) {

  if(chunk) {
    this.write(chunk);
  }

  this.store.put('urls.' + conf.block, this._url, this._buffer.toString('utf-8'), {index:{fetched:1}}, function (err) {
    if (err) {
      console.log('could not store contents of %s. error: %s', this.url, err);
    }
  });

  this._buffer = [];
};

Fetcher.prototype._callback = function (url, cb) {

  var called = false
    , self = this
    , start = Date.now();

  return function (err) {
    if (called) { return; }
    called = true; //make sure we are not called twice
    if (err) {
      log.warn('[%s] error: %s', self.name, err.message);
      self.end();//end and reset stream
    } else {
      log.debug('[%s] crawled %s in %s seconds', self.name, url, (Date.now() - start)/1000);
    }
    //make sure to respect the wait time
    var diff = Date.now() - start;
    if (diff < Fetcher.wait) {
      setTimeout(function () {
        cb();
      }, Fetcher.wait - diff);
    } else {
      cb();
    }
  };

};

Fetcher.prototype.get = function (url, cb) {
  
  if (!url) { return cb(); }

  var self = this
    , requestOptions = Fetcher.requestOptions
    , callback = this._callback(url, cb)
    , req;

  //the url we are fetching
  this._url = url;

  //init request
  requestOptions.url = this._url;

  try {
    req = request(Fetcher.requestOptions);
  } catch (e) {
    return cb(e);
  }

  //register events
  req.on('end', callback);
  req.on('error', callback);

  //happens before any 'data' event
  req.on('response', function (resp) {

    var options = resp.headers || {}
      , ct = resp.headers['content-type'] || '';

    self.extractor.setBaseUrl(self._url);

    //pipes
    if (ct.indexOf('text/') >= 0 && resp.statusCode === 200) {
      req.pipe(self.extractor);
      req.pipe(self);
    } else {
      resp.request.abort();
    }
  });

};

//Public API
exports.init = Fetcher.init;
exports.get = Fetcher.get;
exports.isActive = Fetcher.isActive;
exports.isBusy = Fetcher.isBusy;

