// Cloudflare-Worker-Einstieg. Deployment: siehe README (Abschnitt "KI-Proxy").
import { handleExtract } from './handler.js';

export default {
  async fetch(request, env) {
    return handleExtract(request, env);
  },
};
