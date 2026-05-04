FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install

# Install Chromium browser for Playwright
RUN npx playwright install chromium

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]