# 1. Usar una base que ya sabe de robots buscadores (Puppeteer)
FROM ghcr.io/puppeteer/puppeteer:latest

# 2. Dentro de la caja, crear una carpeta para el robot
WORKDIR /usr/src/app

# 3. Copiar la lista de herramientas (package.json) y el mapa de herramientas (yarn.lock o package-lock.json)
COPY package*.json yarn.lock* ./ 
# (Si solo usas npm y tienes package-lock.json, está bien)

# 4. Instalar las herramientas específicas de tu robot (como 'express')
RUN yarn install --production --frozen-lockfile
# (Puppeteer ya viene con la imagen base)

# 5. Copiar todas las instrucciones de tu robot (el resto de tus archivos)
COPY . .

# 6. Decirle al robot en qué "puerta" interna va a escuchar (ej. puerta 3002)
ENV PORT 3002
EXPOSE 3002

# 7. La instrucción principal para que el robot empiece a trabajar cuando llegue a Render
CMD [ "node", "api_server.js" ]
