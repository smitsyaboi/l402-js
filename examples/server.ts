// examples/server.ts
// Example: L402-paywalled API server
//
// Run with: npx ts-node examples/server.ts
// Then use the example client or curl to test.

import express from 'express';
import { l402, LndConfig } from '../src';

const app = express();
app.use(express.json());

// Configure your LND node (from Polar or your own node)
const node: LndConfig = {
  restHost: process.env.LND_REST_HOST || 'https://127.0.0.1:8082',
  macaroon: process.env.LND_MACAROON || 'YOUR_MACAROON_HEX_HERE',
  skipTlsVerify: true, // Only for development with self-signed certs
};

// Free: service discovery
app.get('/', (_req, res) => {
  res.json({
    service: 'Example L402 API',
    version: '0.1.0',
    endpoints: [
      { path: '/api/joke', price: 10, description: 'Get a random joke' },
      { path: '/api/wisdom', price: 50, description: 'Get a piece of wisdom' },
      { path: '/api/echo', price: 5, description: 'Echo back your message' },
    ],
  });
});

// 10 sats: random joke
app.get(
  '/api/joke',
  l402({ node, price: 10, description: 'Random joke' }),
  (_req, res) => {
    const jokes = [
      'Why do programmers prefer dark mode? Because light attracts bugs.',
      'There are 10 types of people: those who understand binary and those who dont.',
      'A SQL query walks into a bar, sees two tables and asks: Can I join you?',
      'Why do Java developers wear glasses? Because they cant C#.',
      'How many programmers does it take to change a light bulb? None, thats a hardware problem.',
    ];
    res.json({ joke: jokes[Math.floor(Math.random() * jokes.length)] });
  }
);

// 50 sats: wisdom
app.get(
  '/api/wisdom',
  l402({ node, price: 50, description: 'A piece of wisdom' }),
  (_req, res) => {
    const wisdom = [
      'The best time to plant a tree was 20 years ago. The second best time is now.',
      'Ship it, then fix it. Perfection is the enemy of progress.',
      'The obstacle is the way.',
      'What gets measured gets managed.',
      'Simple is not the same as easy.',
    ];
    res.json({ wisdom: wisdom[Math.floor(Math.random() * wisdom.length)] });
  }
);

// 5 sats: echo (demonstrates POST with L402)
app.post(
  '/api/echo',
  l402({ node, price: 5, description: 'Echo service' }),
  (req, res) => {
    res.json({ echo: req.body.message || 'nothing to echo', paid: true });
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`L402 API server running on http://localhost:${PORT}`);
  console.log(`Try: curl http://localhost:${PORT}/`);
  console.log(`Try: curl http://localhost:${PORT}/api/joke`);
});
