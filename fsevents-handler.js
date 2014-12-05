'use strict';

var fs = require('fs');
var sysPath = require('path');
var readdirp = require('readdirp');
var fsevents;
try { fsevents = require('fsevents'); } catch (error) {}

// fsevents instance helpers
var FSEventsWatchers = Object.create(null);

function createFSEventsInstance(path, callback) {
  return (new fsevents(path)).on('fsevent', callback).start();
}

function setFSEventsListener(path, realPath, callback, rawEmitter) {
  var watchPath = sysPath.extname(path) ? sysPath.dirname(path) : path;
  var watchContainer;

  var resolvedPath = sysPath.resolve(path);
  var hasSymlink = resolvedPath !== realPath;
  function filteredCallback(fullPath, flags, info) {
    if (hasSymlink) fullPath = fullPath.replace(realPath, resolvedPath);
    if (
      fullPath === resolvedPath ||
      !fullPath.indexOf(resolvedPath + sysPath.sep)
    ) callback(fullPath, flags, info);
  }

  if (
    watchPath in FSEventsWatchers ||
    // check if there is already a watcher on a parent path
    Object.keys(FSEventsWatchers).some(function(watchedPath) {
      if (!watchPath.indexOf(watchedPath)) {
        watchPath = watchedPath;
        return true;
      }
    })
  ) {
    watchContainer = FSEventsWatchers[watchPath];
    watchContainer.listeners.push(filteredCallback);
  } else {
    watchContainer = FSEventsWatchers[watchPath] = {
      listeners: [filteredCallback],
      rawEmitters: [rawEmitter],
      watcher: createFSEventsInstance(watchPath, function(fullPath, flags) {
        var info = fsevents.getInfo(fullPath, flags);
        watchContainer.listeners.forEach(function(callback) {
          callback(fullPath, flags, info);
        });
        watchContainer.rawEmitters.forEach(function(emitter) {
          emitter(info.event, fullPath, info);
        });
      })
    };
  }
  var listenerIndex = watchContainer.listeners.length - 1;
  return {
    close: function() {
      delete watchContainer.listeners[listenerIndex];
      if (!Object.keys(watchContainer.listeners).length) {
        watchContainer.watcher.stop();
        delete FSEventsWatchers[watchPath];
      }
    }
  };
}

// constructor
function fseventsHandler() {
  // returns boolean indicating whether fsevents can be used
  return fsevents && Object.keys(FSEventsWatchers).length < 128;
}

fseventsHandler.prototype._watchWithFsEvents =
function(watchPath, realPath, pt) {
  if (this._isIgnored(watchPath)) return;
  var watchCallback = function(fullPath, flags, info) {
    var path = pt(sysPath.join(
      watchPath, sysPath.relative(watchPath, fullPath)
    ));
    // ensure directories are tracked
    var parent = sysPath.dirname(path);
    var item = sysPath.basename(path);
    var watchedDir = this._getWatchedDir(
      info.type === 'directory' ? path : parent
    );
    var checkIgnored = function (stats) {
      if (this._isIgnored(path, stats)) {
        this._ignoredPaths[fullPath] = true;
        return true;
      } else {
        delete this._ignoredPaths[fullPath];
      }
    }.bind(this);

    var handleEvent = function (event) {
      if (event === 'unlink') {
        // suppress unlink events on never before seen files (from atomic write)
        if (info.type === 'directory' || watchedDir.has(item)) {
          this._remove(parent, item);
        } else {
          fs.stat(path, function(error, stats) {
            if (!stats || checkIgnored(stats)) return;
            info.type = stats.isDirectory() ? 'directory' : 'file';
            handleEvent('add');
          });
        }
        return; // Don't emit event twice.
      }
      if (checkIgnored()) return;
      if (event === 'add') {
        this._getWatchedDir(parent).add(item);
        if (info.type === 'directory') {
          this._getWatchedDir(path);
        } else if (info.type === 'symlink' && this.options.followSymlinks) {
          return this._addToFsEvents(path, false, true);
        }
      }
      var eventName = info.type === 'directory' ? event + 'Dir' : event;
      this._emit(eventName, path);
    }.bind(this);

    // correct for wrong events emitted
    function addOrChange() {
      handleEvent(watchedDir.has(item) ? 'change' : 'add');
    }
    var wrongEventFlags = [
      69888, 70400, 71424, 72704, 73472, 131328, 131840, 262912
    ];
    if (wrongEventFlags.indexOf(flags) !== -1 || info.event === 'unknown') {
      if (info.event !== 'add' && info.event !== 'change') {
        fs.stat(path, function(error, stats) {
          if (checkIgnored(stats)) return;
          if (stats) {
            addOrChange();
          } else {
            handleEvent('unlink');
          }
        });
      } else {
        addOrChange();
      }
      return;
    }

    switch (info.event) {
    case 'created':
      return addOrChange();
    case 'modified':
      return addOrChange();
    case 'deleted':
      return handleEvent('unlink');
    case 'moved':
      return fs.stat(path, function(error, stats) {
        stats ? addOrChange() : handleEvent('unlink');
      });
    }
  }.bind(this);

  var watcher = setFSEventsListener(
    watchPath,
    realPath,
    watchCallback,
    this.emit.bind(this, 'raw')
  );

  this._emitReady();
  return this._watchers.push(watcher);
};

fseventsHandler.prototype._symlinkForFsEvents =
function(linkPath, add, pt) {
  this._readyCount++;
  fs.readlink(linkPath, function(error, linkTarget) {
    if (this._handleError(error)) return this._emitReady();
    fs.stat(linkTarget, function(error, targetStats) {
      if (this._handleError(error)) return this._emitReady();
      if (targetStats.isDirectory()) {
        this._readyCount++;
        this._addToFsEvents(linkTarget, function(path) {
          var ds = '.' + sysPath.sep;
          return pt(linkTarget && linkTarget !== ds ?
            path.replace(linkTarget, linkPath) :
            path === ds ? linkPath : sysPath.join(linkPath, path));
        });
      } else if (targetStats.isFile()) {
        add();
        this._emitReady();
      }
    }.bind(this));
  }.bind(this));
};

fseventsHandler.prototype._addToFsEvents =
function(file, pathTransform, forceScan) {
  if (!pathTransform) pathTransform = function(val) { return val; };
  var emitAdd = function(path, stats) {
    path = pathTransform(path);
    this._getWatchedDir(sysPath.dirname(path)).add(sysPath.basename(path));
    this._emit(stats.isDirectory() ? 'addDir' : 'add', path, stats);
  }.bind(this);
  var followSymlinks = this.options.followSymlinks;
  if (this.options.ignoreInitial && forceScan !== true) {
    this._emitReady();
  } else {
    fs[followSymlinks ? 'stat' : 'lstat'](file, function(error, stats) {
      if (this._handleError(error)) return this._emitReady();

      if (stats.isDirectory()) {
        emitAdd(pathTransform(file), stats);
        readdirp({
          root: file,
          entryType: 'both',
          fileFilter: this._isntIgnored,
          directoryFilter: this._isntIgnored,
          lstat: true
        }).on('data', function(entry) {
          var entryPath = sysPath.join(file, entry.path);
          var addEntry = emitAdd.bind(null, entryPath, entry.stat);
          if (followSymlinks && entry.stat.isSymbolicLink()) {
            if (this._symlinkPaths[entry.fullPath]) return;
            else this._symlinkPaths[entry.fullPath] = true;
            this._symlinkForFsEvents(entryPath, addEntry, pathTransform);
          } else {
            addEntry();
          }
        }.bind(this)).on('end', this._emitReady);
      } else {
        emitAdd(file, stats);
        this._emitReady();
      }
    }.bind(this));
  }
  if (this.options.persistent) {
    fs.realpath(file, function(error, realPath) {
      if (error) realPath = file;
      this._watchWithFsEvents(file, sysPath.resolve(realPath), pathTransform);
    }.bind(this));
  }
  return this;
};

module.exports = fseventsHandler;
