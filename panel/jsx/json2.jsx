/*
 * Minimal JSON for ExtendScript (which ships without it).
 * Only stringify/parse of plain data — enough to move structs across the bridge.
 */
if (typeof JSON !== 'object') { JSON = {}; }

(function () {
    'use strict';

    // Built from a string literal so this source file stays plain ASCII.
    var escapable = new RegExp(
        '[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u0600-\\u0604\\u070f' +
        '\\u17b4\\u17b5\\u200c-\\u200f\\u2028-\\u202f\\u2060-\\u206f' +
        '\\ufeff\\ufff0-\\uffff]', 'g');

    var meta = {
        '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r'
    };

    function quote(string) {
        // Backslash and quote are outside `escapable`, so handle them first.
        string = String(string).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        escapable.lastIndex = 0;
        return '"' + string.replace(escapable, function (a) {
            var c = meta[a];
            if (typeof c === 'string') { return c; }
            return '\\u' + ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
    }

    function str(value) {
        if (value === null || value === undefined) { return 'null'; }
        switch (typeof value) {
            case 'string':  return quote(value);
            case 'number':  return isFinite(value) ? String(value) : 'null';
            case 'boolean': return String(value);
            case 'object':  break;
            default:        return 'null';
        }

        var i, partial = [];
        if (Object.prototype.toString.apply(value) === '[object Array]') {
            for (i = 0; i < value.length; i += 1) { partial[i] = str(value[i]); }
            return '[' + partial.join(',') + ']';
        }
        for (var k in value) {
            if (Object.prototype.hasOwnProperty.call(value, k)) {
                var v = str(value[k]);
                if (v) { partial.push(quote(k) + ':' + v); }
            }
        }
        return '{' + partial.join(',') + '}';
    }

    if (typeof JSON.stringify !== 'function') {
        JSON.stringify = function (value) { return str(value); };
    }

    if (typeof JSON.parse !== 'function') {
        JSON.parse = function (text) {
            // ExtendScript has no native parser; every payload we parse is our own.
            return eval('(' + String(text) + ')');
        };
    }
}());
