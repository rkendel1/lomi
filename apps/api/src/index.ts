import { createApiServer } from './app';

const port = Number(process.env.PORT ?? 4000);
const server = createApiServer();

server.listen(port, '0.0.0.0', () => {
  console.log(`lomi-api listening on http://0.0.0.0:${port}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
