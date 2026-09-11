FROM node:20-alpine

WORKDIR /app

# No dependencies: the gate is built on Node's standard library only.
COPY server.js ./
COPY index.html ./
COPY public/ ./public/

ENV PORT=8080
EXPOSE 8080

# SITE_PASSCODE must be supplied at run time; the server refuses to start
# without it rather than quietly serving the trip details to everyone.
#   docker run -e SITE_PASSCODE=... -e SESSION_SECRET=... -p 8080:8080 <image>

USER node
CMD ["node", "server.js"]
