const { spawn } = require('child_process');
const http = require('http');
const { createHash } = require('crypto');

const listenAllEvents = process.env.EV_DEBUG ? (emitter, name) => {
  let evNames = [];

  if (typeof emitter.eventNames === 'function') {
    evNames = emitter.eventNames();

    if (!evNames.length) {
      console.log(`evspy noev> [${name}]: no events to subscribe`);
    }
  }
  else {
    console.log(`evspy noev> cannot get eventNames from ${name}`);
  }

  for (const evName of evNames) {
    emitter.prependListener(evName, (p1, p2, p3, p4, p5) => {
      const transformValues = (param) => {
        if (param !== undefined && param !== null) {
          let description = typeof param;

          if (typeof param.constructor === 'function' && param.constructor.name) {
            description = param.constructor.name;
          }

          if (typeof param === 'object') {
            const expansion = Object.keys(param).slice(0,5).map((e) => transformValues(e));
            description = `${description}[${expansion.join(', ')}]`;
          }
          else if (typeof param === 'string') {
            description = `${description}=${param.substring(0, 8)}`;
          }
          else if (typeof param === 'number' || typeof param === 'boolean') {
            description = `${description}=${param}`;
          }

          return description;
        }

        return param;
      }

      console.log(`evspy ev:${name}:${evName}(${[p1, p2, p3, p4, p5].filter((e) => e !== undefined).map((e) => transformValues(e)).join(', ')})`);
    });
  }

  if (evNames.length) {
    console.log(`evspy subs> [${name}]: subscribed events: [${evNames.join(', ')}]`);
  }
} : () => {}

// we need some global state because the on demand service launching logic and we can only have 1 service running only at once
let raspividChild;
let numRaspividSockets = 0;

const serveRaspivid = (request, response) => {
  if (!numRaspividSockets) { // check for raspivid running state, if its not, spawn it
    raspividChild =
      spawn('raspivid',
        ['-n', // Do not display a preview window
        '-ih', // Insert inline headers (SPS, PPS) to stream
        '-w', '1280', // Set image width <size>. Default 1920
        '-h', '720', // Set image height <size>. Default 1080
        '-t', '0', // Time (in ms) to capture for. If not specified, set to 5s. Zero to disable
        '-rot', '0', // Set image rotation (0-359)
        '-fps', '15', // Specify the frames per second to record
        '-b', '1000000', //  Set bitrate. Use bits per second (e.g. 10MBits/s would be -b 10000000)
        '-o', '-']); // Output filename <filename> (to write to stdout, use '-o -').

    raspividChild.stderr.on('data', (data) => { // log any errors produced by raspivid to console
      console.log(`raspivid> error:${data.toString()}`);
    });

    console.log('raspivid> spawned');

    listenAllEvents(raspividChild, `raspividChild>`);
    listenAllEvents(raspividChild.stdout, `raspividChild.stdout>`);
    listenAllEvents(raspividChild.stderr, `raspividChild.stderr>`);
  }

  numRaspividSockets++;
  raspividChild.stdout.pipe(response); // send data to clients

  request.socket.on('end', () => { // on socket close if no active users remain, shutdown raspivid
    console.timeEnd(request.requestId);
    numRaspividSockets--;

    if (!numRaspividSockets) {
      raspividChild.kill();
      console.log('raspivid> killed');
    }
  });
}

const serveRaspistill = (request, response) => {
  let canceled = false;
  request.connection.on('close', () => {
    console.log('raspistill> ${request.requestId}: cancelled');
    canceled = true;
  });

  const raspistillChild =
    spawn('raspistill',
      ['-n', // Do not display a preview window
      '-w', '1280', // Set image width <size>
      '-h', '720', // Set image height <size>
      '-t', '1', // Time (in ms) before takes picture and shuts down (if not specified, set to 5s)
      '-rot', '0', // Set image rotation (0-359)
      '-o', '-']); // Output filename <filename> (to write to stdout, use '-o -').

  raspistillChild.on('exit', () => { // measure image processing and log it
    console.timeEnd(request.requestId);
    //response.end();
    //request.socket.end();
  });

  // if image capture goes system widely somewhere, the capture will fail, so handle it with this little peeking strategy
  raspistillChild.stdout.once('data', (data) => {
    if (canceled) {
      response.writeHead(201, { ...response.defaultHeaders, 'Content-Type': 'text/plain' });
      response.end();
    }
    else {
      response.writeHead(200, { ...response.defaultHeaders, 'Content-Type': 'image/jpeg' });
      response.write(data);
      raspistillChild.stdout.pipe(response);
    }
  });

  raspistillChild.stderr.on('data', (data) => {
	  console.log(`raspistill> error:${data.toString()}`);
	  response.writeHead(400, { ...response.defaultHeaders, 'Content-Type': 'text/plain' });
	  response.end(data.toString());
  });

  listenAllEvents(raspistillChild, `raspistillChild> ${request.requestId}`);
  listenAllEvents(raspistillChild.stdout, `raspistillChild.stdout> ${request.requestId}`);
  listenAllEvents(raspistillChild.stderr, `raspistillChild.stderr> ${request.requestId}`);
}

const handlers = {
  '/stream': (request, response) => serveRaspivid(request, response),
  '/still': (request, response) => serveRaspistill(request, response),
}

const server = http.createServer((request, response) => {
  request.requestDesc = `remote-{${request.connection.remoteAddress}:${request.connection.remotePort}} local-{${request.connection.localAddress}:${request.connection.localPort}} url-{${request.url}} @{${Math.floor(Date.now()*0.001)}}`;
  request.requestId = `${createHash('md5').update(request.requestDesc).digest('hex')}`;
  response.defaultHeaders = {
    'Connection': 'close',
  };

  console.time(request.requestId);

  try {
    const handler = handlers[request.url];

	  if (handler) {
      listenAllEvents(request.socket, `request.socket> ${request.requestId}`);
      listenAllEvents(response, `response> ${request.requestId}`);
      handler(request, response);
    }
    else {
      response.writeHead(404, response.defaultHeaders);
      response.end();
    }

	  console.log(`incoming> ${request.requestId} ${request.requestDesc} ${handler ? '' : 404}`);
  }
  catch (e) {
    response.writeHead(500, { ...response.defaultHeaders, 'Content-Type': 'text/plain' });
    response.end(e.toString());

    console.log(`exception> ${request.requestId}>\n${e.stack}`);
  }
});

listenAllEvents(server, 'server');

const port = process.env.PORT || 8080;
server.listen(port);
console.log(`Raspberry Pi camera relay service. port> ${port}`);
