'use strict';

// Module imports
var log = require('npmlog-ts')
  , express = require('express')
  , WebSocketServer = require('ws').Server
  , restify = require('restify')
  , http = require('http')
  , bodyParser = require('body-parser')
  , util = require('util')
  , async = require('async')
;

// Log stuff
log.level     = 'verbose';
log.timestamp = true;

/**/
// DBCS APEX stuff
const DBZONEHOST = "https://apex.digitalpracticespain.com";
var   DBZONEURI = "/apex/pdb1/anki/zone/steps/{demozone}/{id}";
var   DBDOCSSETUP = "/apex/pdb1/anki/docs/setup/{demozone}";
// SOACS stuff
const SOAHOST = "http://soa.digitalpracticespain.com:8001";
const DRONELANDURI = "/soa-infra/resources/default/DroneHelper/DispatchDroneService/drone/land";
var   DRONESTATUSURI = "/BAMHelper/UpdateDroneStatusService/anki/event/drone/{demozone}/{status}";
// Event server
const EVENSERVERHOST = "http://proxy.digitalpracticespain.com:10001"
const DRONEEVENTURI = "/event/drone"
/**/

/**
// DBCS APEX stuff
const DBZONEHOST = "https://new.apex.digitalpracticespain.com";
var   DBZONEURI = "/ords/pdb1/anki/zone/steps/{demozone}/{id}";
var   DBDOCSSETUP = "/ords/pdb1/anki/docs/setup/{demozone}";
// SOACS stuff
const SOAHOST = "http://new.soa.digitalpracticespain.com:8001";
const DRONELANDURI = "/soa-infra/resources/default/DroneHelper/DispatchDroneService/drone/land";
var   DRONESTATUSURI = "/BAMHelper/UpdateDroneStatusService/anki/event/drone/{demozone}/{status}";
// Event server
const EVENSERVERHOST = "http://new.proxy.digitalpracticespain.com:10001"
const DRONEEVENTURI = "/event/drone"
**/

// Local stuff
const URI = '/go/:demozone/:corrid/:folder/:zone/:source?';
const pingURI = "/ping";

// Other constants
const PONG               = "ping";
const DRONEONGOING       = "go";
const DRONETAKINGPICTURE = "picture";
const DRONERETURNING     = "return";
const DRONELANDING       = "landing";
const DRONEDOWNLOADING   = "downloading";
const FINISH             = "finish";

// Ping handling
var timer = undefined;
var responseObj = undefined;
var waitingPing = false;
var timeout = 5000;

// Instantiate classes & servers
var app    = express()
  , router = express.Router()
  , server = http.createServer(app)
  , dbClient = restify.createJsonClient({
    url: DBZONEHOST,
    rejectUnauthorized: false
  })
  , soaClient = restify.createJsonClient({
    url: SOAHOST,
    rejectUnauthorized: false
  })
  , eventClient = restify.createJsonClient({
    url: EVENSERVERHOST,
    connectTimeout: 1000,
    requestTimeout: 1000,
    retry: false,
    headers: {
      "content-type": "application/json"
    }
  })
;

// Workaround for BOT handling until we can patch the Drone App
var sourceMap = [];

// ************************************************************************
// Main code STARTS HERE !!
// ************************************************************************

// Main handlers registration - BEGIN
// Main error handler
process.on('uncaughtException', function (err) {
  log.error("","Uncaught Exception: " + err);
  log.error("","Uncaught Exception: " + err.stack);
});
// Detect CTRL-C
process.on('SIGINT', function() {
  log.error("","Caught interrupt signal");
  log.error("","Exiting gracefully");
  process.exit(2);
});
// Main handlers registration - END

const PORT = process.env.DRONEPORT || 9999;
const wsURI = '/ws';

var currentDemozone = "";

// REST engine initial setup
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
const restURI = '/drone';
var ws = undefined;
var currentCorrId = undefined;
var source = undefined;

// WEBSOCKET stuff - BEGIN

var wss = new WebSocketServer({
  server: server,
  path: wsURI,
  verifyClient: function (info) {
    return true;
  }
});

wss.on('connection', function(_ws) {

  log.info("","WS session connected");
  ws = _ws;

  _ws.on('close', function() {
    log.info("","WS session disconnected");
    ws = undefined;
//    currentCorrId = undefined;
  });

  _ws.on('message', function(data, flags) {
    var jsonData = JSON.parse(data);
    log.info("","Incoming data received: %j", jsonData);

    if ( jsonData.result.toLowerCase() === PONG) {
      if ( !waitingPing) {
        return;
      }
      waitingPing = false;
      clearTimeout(timer);
      timer = undefined;
      responseObj.status(200).send({ message: "OK"});
      return;
    }
    if ( !jsonData.id) {
        log.error("","Invalid message received: " + data);
        return;
    }
    if ( !jsonData.demozone || jsonData.demozone === "") {
        log.error("","No demozone received!!: " + data);
        return;
    }
    if ( !currentCorrId) {
      log.error("","No correlation id stored now!. Ignoring command.");
      return;
    }
    if ( currentCorrId !== jsonData.id) {
      log.error("","Current correlation id (%s) doesn't match incoming id: %s", currentCorrId, jsonData.id);
      return;
    }
    // Up to this point, we receive a valid "finish" or "changedStatus" message that we were waiting.
    // TODO: Invoke external API to notify drone tasks are done

    var status = undefined;
    if ( jsonData.result.toLowerCase() === DRONEONGOING) {
      status = "GOING";
    } else if ( jsonData.result.toLowerCase() === DRONETAKINGPICTURE) {
      status = "TAKING PICTURE";
    } else if ( jsonData.result.toLowerCase() === DRONERETURNING) {
      status = "RETURNING";
    } else if ( jsonData.result.toLowerCase() === DRONELANDING) {
      status = "LANDING";
    } else if ( jsonData.result.toLowerCase() === DRONEDOWNLOADING) {
      status = "DOWNLOADING";
    } else if ( jsonData.result.toLowerCase() === FINISH) {
      status = "LANDED";

      // Workaround for BOT handling until we can patch the Drone App
      var s;
      var sourceRecord = sourceMap.find(o => o.corrId === jsonData.id);
      if (sourceRecord) {
        s = sourceRecord.source;
        var i = sourceMap.findIndex(o => o.corrId === jsonData.id);
        sourceMap.splice(i,1);
      } else {
        s = 'PCS';
      }

      var data = {
        SOURCE: s,
        PROCESSID : jsonData.id,
        DEMOZONE : currentDemozone,
        result : "OK"
      };
      log.info("","Callback to be invoked with: %j", data);
      soaClient.post(DRONELANDURI, data, function(err, _req, _res, obj) {
        if (err) {
          console.log(err);
        } else {
          log.info("","Callback invoked successfully");
        }
      });
    } else {
      // TODO
    }
/**
    // Update drone status in BAM
    soaClient.post(DRONESTATUSURI.replace('{demozone}', jsonData.demozone).replace('{status}', encodeURI(status)), function(err, _req, _res, obj) {
      if (err) {
        console.log(err);
      } else {
        log.info("","Drone status updated successfully");
      }
    });
**/
    // Send drone status change to the event server. Payload structure follows IoTCS one to ease things in the event server
    var jsonPayload = [{
      payload: {
        data: {
          data_demozone: currentDemozone,
          status: status
        }
      }
    }];
    eventClient.post(DRONEEVENTURI, jsonPayload, function(err, _req, _res, obj) {
      if (err) {
        console.log(err);
      } else {
        log.info("","Status sent to event server successfully");
      }
    });

  });
});
// WEBSOCKET stuff - END

// REST stuff - BEGIN
router.post(URI, function(req, res) {
  log.info("","POST request: %j", req.params);
  source = "PCS"; // By default, if source is not comming is because request should have come from PCS
  currentDemozone = req.params.demozone;
  DBZONEURI   = DBZONEURI.replace('{demozone}', currentDemozone);
  DBDOCSSETUP = DBDOCSSETUP.replace('{demozone}', currentDemozone);
  if (req.params.source) {
    source = req.params.source;
  }
  var corrId = req.params.corrid;

  // Workaround for BOT handling until we can patch the Drone App
  sourceMap.push({corrId: corrId, source: source});

  currentCorrId = corrId;
  var folderId = req.params.folder;
  var zone = req.params.zone;

  var self = this;
  var command = {};
  var response = "";
  command.source = source;
  command.corrId = corrId;
  command.demozone = currentDemozone;

  async.series({
    docs: function(callback) {
      dbClient.get(DBDOCSSETUP, function(err, _req, _res, obj) {
        if (err) {
          console.log(err);
          callback(err.message);
        }
        if ( obj.items.length > 0) {
          var DOCS = obj.items[0];
          DOCS.folderId = folderId;
          command.DOCS = DOCS;
          callback(null);
        } else {
          response = "NO DOCS SETUP INFO FOUND IN THE DATABASE";
          callback(response);
        }
      });
    },
    commands: function(callback) {
      dbClient.get(DBZONEURI.replace('{id}', zone), function(err, _req, _res, obj) {
        if (err) {
          console.log(err);
          callback(err.message);
        }
        if ( obj.items.length > 0) {
          var commands = JSON.parse(obj.items[0].commands);
          command.steps = commands;
          callback(null);
        } else  {
          response = "Requested ZONE not found in database.";
          callback(response);
        }
      });
    }
  }, function (err, results) {
    if (err) {
      res.status(500).send({ message: err });
    } else {
      // "command" object contains all data. Send it over WS
      // log.info("","%j", command);
      if ( ws) {
        ws.send(JSON.stringify(command));
        response = "Command sent successfully";
        res.send({ message: response });
      } else {
        // WebSocket session not opened when received the command!!
        log.error("","Request received but no WS session opened!");
        response = "WebSocket session not opened!";
        res.status(500).send({ message: response });
      }
    }
  });
});

router.get(pingURI, function(req, res) {
  log.info("","PING request received...");
  if (!ws) {
    log.error("","NO WS session opened");
    res.status(503).send({ message: "WS session not opened"});
    return;
  } else {
    responseObj = res;
    waitingPing = true;
    timer = setTimeout(function(){
      responseObj.status(408).send({ message: "TIMEOUT"});
      waitingPing = false;
      responseObj = undefined;
      timer = undefined;
    }, timeout);
    ws.send(JSON.stringify( { steps: [ { command: "ping" } ] } ));
  }
});

router.get('/', function(req, res) {
  log.info("","REST request");
  res.send({ message: "Usage: POST /drone" + URI });
});
app.use(restURI, router);
// REST stuff - END

server.listen(PORT, function() {
  log.info("","REST server running on http://localhost:" + PORT + restURI + URI);
  log.info("","WS server running on http://localhost:" + PORT + wsURI);
});
