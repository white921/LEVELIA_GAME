export interface Config {
  discordToken: string;
  mysqlUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Required environment variable is missing: ${name}`);
    return value;
  };

  const discordToken = required('DISCORD_TOKEN');
  const mysqlUrl = required('MYSQL_URL');
  let parsed: URL;
  try {
    parsed = new URL(mysqlUrl);
  } catch {
    throw new Error('MYSQL_URL must be a valid mysql:// URL');
  }
  if (parsed.protocol !== 'mysql:' || !parsed.hostname || parsed.pathname.length <= 1) {
    throw new Error('MYSQL_URL must use mysql:// and include a host and database name');
  }

  return { discordToken, mysqlUrl };
}
