module.exports = {
  apps: [
    {
      name: "provider-proxy",
      script: "provider-proxy.js",
      env: {
        PROXY_PORT: 9999,
        PROXY_BIND: "0.0.0.0",
        AGY_BIN: process.env.AGY_BIN || "agy",
      },
    },
  ],
};
