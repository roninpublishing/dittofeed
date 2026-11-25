import config from "../src/config";

// Test-only encryption identity, never an application default or CI/live secret.
// Install before creating newsletters or automation plans; restore per test.
export function installNewsletterSecretFixture(): () => void {
  const previousEnv = process.env.SECRET_KEY;
  const previousKey = config().secretKey;
  const key = Buffer.alloc(32, 7).toString("base64");
  process.env.SECRET_KEY = key;
  config().secretKey = key;
  return () => {
    if (previousEnv === undefined) delete process.env.SECRET_KEY;
    else process.env.SECRET_KEY = previousEnv;
    config().secretKey = previousKey;
  };
}
