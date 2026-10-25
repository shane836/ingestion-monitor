FROM mcr.microsoft.com/playwright:v1.60.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /app/state && chown -R pwuser:pwuser /app
COPY --chown=pwuser:pwuser src ./src
COPY --chown=pwuser:pwuser projects.json ./projects.json
USER pwuser
EXPOSE 8080
VOLUME ["/app/state"]
CMD ["node", "src/service.mjs"]
