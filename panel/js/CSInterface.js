/*
 * CSInterface (compact) — Raunen
 *
 * A hand-written subset of Adobe's CSInterface.js covering only what this panel
 * uses. It talks to the same underlying `window.__adobe_cep__` bridge, so you can
 * drop in Adobe's official CSInterface.js over this file at any time and
 * everything keeps working.
 */

/* eslint-disable no-var */
'use strict';

var SystemPath = {
  USER_DATA: 'userData',
  COMMON_FILES: 'commonFiles',
  MY_DOCUMENTS: 'myDocuments',
  APPLICATION: 'application',
  EXTENSION: 'extension',
  HOST_APPLICATION: 'hostApplication'
};

/** A CEP event, used for host <-> panel messaging. */
function CSEvent(type, scope, appId, extensionId) {
  this.type = type;
  this.scope = scope || 'APPLICATION';
  this.appId = appId;
  this.extensionId = extensionId;
  this.data = '';
}

function CSInterface() {}

CSInterface.prototype.hostEnvironment = (function () {
  try {
    return JSON.parse(window.__adobe_cep__.getHostEnvironment());
  } catch (e) {
    return null;
  }
})();

CSInterface.prototype.getHostEnvironment = function () {
  this.hostEnvironment = JSON.parse(window.__adobe_cep__.getHostEnvironment());
  return this.hostEnvironment;
};

CSInterface.prototype.getOSInformation = function () {
  var ua = window.navigator.userAgent;
  if (ua.indexOf('Windows') >= 0) {
    var arch = window.navigator.platform === 'Win64' || ua.indexOf('WOW64') >= 0 ? '64' : '32';
    return 'Windows ' + arch + ' bit';
  }
  if (ua.indexOf('Mac') >= 0) return 'Mac OSX';
  return 'Unknown Operation System';
};

/**
 * Runs an ExtendScript string in the host app. `callback` receives the result as
 * a string; ExtendScript's `EvalScript error.` is returned verbatim on failure.
 */
CSInterface.prototype.evalScript = function (script, callback) {
  if (callback === null || callback === undefined) callback = function () {};
  window.__adobe_cep__.evalScript(script, callback);
};

CSInterface.prototype.getApplicationID = function () {
  return this.hostEnvironment ? this.hostEnvironment.appId : '';
};

CSInterface.prototype.getExtensionID = function () {
  return window.__adobe_cep__.getExtensionId();
};

/**
 * Resolves a CEP path constant to a plain OS path. CEP hands these back as
 * `file:///C:/...` URLs, which nothing else on the system accepts.
 */
CSInterface.prototype.getSystemPath = function (pathType) {
  var path = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
  var os = this.getOSInformation();
  if (os.indexOf('Windows') >= 0) {
    path = path.replace('file:///', '');
  } else if (os.indexOf('Mac') >= 0) {
    path = path.replace('file://', '');
  }
  return path;
};

CSInterface.prototype.addEventListener = function (type, listener, obj) {
  window.__adobe_cep__.addEventListener(type, listener, obj);
};

CSInterface.prototype.removeEventListener = function (type, listener, obj) {
  window.__adobe_cep__.removeEventListener(type, listener, obj);
};

CSInterface.prototype.dispatchEvent = function (event) {
  if (typeof event.data === 'object') event.data = JSON.stringify(event.data);
  window.__adobe_cep__.dispatchEvent(event);
};

CSInterface.prototype.openURLInDefaultBrowser = function (url) {
  return window.cep.util.openURLInDefaultBrowser(url);
};

CSInterface.prototype.setWindowTitle = function (title) {
  window.__adobe_cep__.invokeSync('setWindowTitle', title);
};

/** Host UI theme, so the panel can follow Premiere's brightness setting. */
CSInterface.prototype.getHostCapabilities = function () {
  return JSON.parse(window.__adobe_cep__.getHostCapabilities());
};

CSInterface.prototype.initResourceBundle = function () {
  return {};
};
