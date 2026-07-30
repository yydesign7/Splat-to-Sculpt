import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import {
  cleanupOldEphemeralSessionsOnStartup,
  installEphemeralExitCleanup,
} from './lib/ephemeral-cleanup';

const dev = process.env.COZE_PROJECT_ENV !== 'PROD';
const hostname = process.env.HOSTNAME || 'localhost';
const port = parseInt(process.env.PORT || '5001', 10);

installEphemeralExitCleanup();

async function main() {
  await cleanupOldEphemeralSessionsOnStartup();

  // Create Next.js app
  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();

  await app.prepare();
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });
  server.once('error', err => {
    console.error(err);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(
      `> Server listening at http://${hostname}:${port} as ${
        dev ? 'development' : process.env.COZE_PROJECT_ENV
      }`,
    );
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
