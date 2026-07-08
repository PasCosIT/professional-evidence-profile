const handleRequest = require("../server.cjs");

module.exports = (req, res) => {
  return handleRequest(req, res);
};