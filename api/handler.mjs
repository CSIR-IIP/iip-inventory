// Single Vercel serverless function handling every /api/* route (keeps the Hobby plan's function count at one).
import { createHandler } from '../server/app.mjs';
import { getServices } from '../server/firebase.mjs';

export default createHandler({ getServices });
