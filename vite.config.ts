import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { runOffsiteEvaluation } from './server/offsite-evaluate';
import { runOffsiteSuggestionEvaluation } from './server/offsite-evaluate-suggestion';
import {
  handleSpacecatProxyConfigRequest,
  handleSpacecatProxyRequest,
} from './server/spacecat-proxy';

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
        const requestUrl = req.url ?? '';
        const requestMethod = req.method ?? 'GET';

        if (requestUrl === '/api/spacecat-config' && requestMethod === 'GET') {
          void (async () => {
            const response = await handleSpacecatProxyConfigRequest(
              new Request(`http://localhost${requestUrl}`, {
                method: requestMethod,
              }),
              {
                SPACECAT_API_KEY: env.SPACECAT_API_KEY,
                SPACECAT_API_BASE_URL: env.SPACECAT_API_BASE_URL,
              },
            );
            res.statusCode = response.status;
            response.headers.forEach((value, name) => {
              res.setHeader(name, value);
            });
            res.end(await response.text());
          })();
          return;
        }

        if (requestUrl.startsWith('/api/spacecat') && requestMethod === 'GET') {
          void (async () => {
            const response = await handleSpacecatProxyRequest(
              new Request(`http://localhost${requestUrl}`, {
                method: requestMethod,
              }),
              {
                SPACECAT_API_KEY: env.SPACECAT_API_KEY,
                SPACECAT_API_BASE_URL: env.SPACECAT_API_BASE_URL,
              },
            );
            res.statusCode = response.status;
            response.headers.forEach((value, name) => {
              res.setHeader(name, value);
            });
            res.end(await response.text());
          })();
          return;
        }

        if (
          requestUrl !== '/api/offsite-evaluate' &&
          requestUrl !== '/api/offsite-evaluate-suggestion'
        ) {
          next();
          return;
        }

        if (requestMethod !== 'POST') {
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
            const sharedEnv = {
              SPACECAT_API_KEY: env.SPACECAT_API_KEY,
              SPACECAT_API_BASE_URL: env.SPACECAT_API_BASE_URL,
              AWS_BEARER_TOKEN_BEDROCK: env.AWS_BEARER_TOKEN_BEDROCK,
              BEDROCK_BEARER_TOKEN: env.BEDROCK_BEARER_TOKEN,
              AWS_REGION: env.AWS_REGION,
              BEDROCK_REGION: env.BEDROCK_REGION,
              BEDROCK_MODEL_ID: env.BEDROCK_MODEL_ID,
              BEDROCK_MODEL: env.BEDROCK_MODEL,
              BRIGHTDATA_API_KEY: env.BRIGHTDATA_API_KEY,
              BRIGHTDATA_WEB_UNLOCKER_ZONE: env.BRIGHTDATA_WEB_UNLOCKER_ZONE,
              BRIGHTDATA_YOUTUBE_COMMENT_DATASET_ID:
                env.BRIGHTDATA_YOUTUBE_COMMENT_DATASET_ID,
              BRIGHTDATA_REDDIT_COMMENT_DATASET_ID:
                env.BRIGHTDATA_REDDIT_COMMENT_DATASET_ID,
              BRIGHTDATA_REDDIT_POST_DATASET_ID:
                env.BRIGHTDATA_REDDIT_POST_DATASET_ID,
              BRIGHTDATA_YOUTUBE_VIDEO_DATASET_ID:
                env.BRIGHTDATA_YOUTUBE_VIDEO_DATASET_ID,
              OPENAI_API_KEY: env.OPENAI_API_KEY,
              OPENAI_EVALUATOR_MODEL: env.OPENAI_EVALUATOR_MODEL,
              AZURE_OPENAI_ENDPOINT: env.AZURE_OPENAI_ENDPOINT,
              AZURE_OPENAI_KEY: env.AZURE_OPENAI_KEY,
              AZURE_OPENAI_DEPLOYMENT: env.AZURE_OPENAI_DEPLOYMENT,
            };
            const result =
              req.url === '/api/offsite-evaluate-suggestion'
                ? await runOffsiteSuggestionEvaluation(payload, sharedEnv)
                : await runOffsiteEvaluation(payload, sharedEnv);

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
