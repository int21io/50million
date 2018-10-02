const http = require('http');
const express = require('express')
const opn = require("opn");

const SERVER_PORT = 8080;

// Run a server to host the site
const app = express()
const server = http.createServer(app);
app.use(express.static('.'))
server.listen(SERVER_PORT, () => console.log(`Server listening on port ${SERVER_PORT}`));

// Open the users browser to the 
opn(`http://localhost:${SERVER_PORT}`);
