# Site server: renders the page templates (scripts/site.mjs) from the API's data. No npm dependencies.
FROM node:22-alpine
WORKDIR /app
COPY scripts/ scripts/
COPY src/ src/
COPY web/ web/
COPY site.config.json vercel.json ./
RUN mkdir -p /app/.local && chown node /app/.local
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "web/server.mjs"]
