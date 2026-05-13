TARGETS='[
  {"pathPrefix":"/kimi","host":"api.kimi.com","headers":{"x-app":"cli"}},
  {"pathPrefix":"/openai","host":"api.openai.com"}
]' \
USER_AGENT='claude-cli/2.1.139 (external, cli)' \
PROXY_PORT=9997 \
node provider-proxy.js
