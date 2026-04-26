declare module "$amplify/env/daily-trends" {
  export const env: {
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    AWS_SESSION_TOKEN: string;
    AWS_REGION: string;
    AMPLIFY_DATA_DEFAULT_NAME: string;
    [key: string]: string | undefined;
  };
}

declare module "$amplify/env/regenerate-daily-puzzle" {
  export const env: {
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    AWS_SESSION_TOKEN: string;
    AWS_REGION: string;
    AMPLIFY_DATA_DEFAULT_NAME: string;
    [key: string]: string | undefined;
  };
}
