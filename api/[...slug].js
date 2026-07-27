const server = require('../server.js');

module.exports = function (req, res) {
  server.emit('request', req, res);
};
