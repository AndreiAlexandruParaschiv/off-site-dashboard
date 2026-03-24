import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { runOffsiteEvaluation } from './server/offsite-evaluate';

const ALLOWED_VITE_HOSTS = ['.netlify.app'];

function evaluationDevMiddleware(env: Record<string, string>) {
  return {
    name: 'evaluation-dev-middleware',
    configureServer(server: {
      middlewares: {
        use: (
          handler: (
            req: {
              method?: string;
              url?: string;
              on: (event: string, callback: (chunk?: Buffer) => void) => void;
            },
            res: {
              statusCode: number;
              setHeader: (name: string, value: string) => void;
              end: (chunk: string) => void;
            },
            next: () => void,
          ) => void,
        ) => void;
      };
    }) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/api/offsite-evaluate' || req.method !== 'POST') {
          next();
          return;
        }

        const chunks: Uint8Array[] = [];

        req.on('data', (chunk?: Uint8Array) => {
          if (chunk) {
            chunks.push(chunk);
          }
        });
        req.on('end', async () => {
          try {
            const rawBody = Buffer.concat(chunks).toString('utf-8');
            const payload = rawBody ? JSON.parse(rawBody) : {};
            const result = await runOffsiteEvaluation(payload, {
              AWS_BEARER_TOKEN_BEDROCK: env.AWS_BEARER_TOKEN_BEDROCK,
              AWS_REGION: env.AWS_REGION,
              BEDROCK_MODEL_ID: env.BEDROCK_MODEL_ID,
              OPENAI_API_KEY: env.OPENAI_API_KEY,
              OPENAI_EVALUATOR_MODEL: env.OPENAI_EVALUATOR_MODEL,
              AZURE_OPENAI_ENDPOINT: env.AZURE_OPENAI_ENDPOINT,
              AZURE_OPENAI_KEY: env.AZURE_OPENAI_KEY,
              AZURE_OPENAI_DEPLOYMENT: env.AZURE_OPENAI_DEPLOYMENT,
            });

            res.statusCode = 200;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(result));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(
              JSON.stringify({
                error:
                  error instanceof Error
                    ? error.message
                    : 'Unexpected evaluation error.',
              }),
            );
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    // Relative asset paths simplify GitHub Pages project-site hosting.
    base: './',
    plugins: [react(), evaluationDevMiddleware(env)],
    server: {
      allowedHosts: ALLOWED_VITE_HOSTS,
    },
    preview: {
      allowedHosts: ALLOWED_VITE_HOSTS,
    },
  };
});
