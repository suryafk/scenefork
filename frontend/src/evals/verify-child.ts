// One verification in its own process, so a plugin stuck in a loop can be killed (the app gets
// this from its 300 ms verifier-worker kill). Reads a VerifyRequest on stdin, writes the result.
import { initRapier } from '../sim/SimCore';
import { verifyPlugin, type VerifyRequest } from '../sim/verifier';

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const req = JSON.parse(Buffer.concat(chunks).toString('utf8')) as VerifyRequest;
await initRapier();
process.stdout.write(JSON.stringify(verifyPlugin(req)));
