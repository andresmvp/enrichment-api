# Usa una imagen base de Node.js basada en Debian
FROM node:18-bullseye-slim

LABEL maintainer="andresmvp <andres@auteam.io>" # Puedes poner tu info
LABEL description="JH Enrichment API application con Puppeteer-Core y Chromium"

# Variables de entorno importantes
ENV APP_HOME /usr/src/app
ENV NODE_ENV production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD true
ENV PUPPETEER_EXECUTABLE_PATH /usr/bin/chromium

# Puerto que la aplicación de enriquecimiento escuchará DENTRO del contenedor
ENV PORT 3002 # Hemos decidido usar 3002 para esta app

# Actualizar lista de paquetes e instalar dependencias del sistema para Chromium
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-khmeros \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    ca-certificates \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libgdk-pixbuf-2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    dumb-init \
    && apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Crear directorio de la aplicación y establecerlo como directorio de trabajo
RUN mkdir -p ${APP_HOME}
WORKDIR ${APP_HOME}

# Copiar package.json y package-lock.json primero
COPY package.json package-lock.json* ./

# Instalar dependencias de Node.js
RUN npm ci --only=production

# Copiar el resto del código de la aplicación
COPY . .

# Crear un usuario no-root
RUN groupadd --gid 1001 nodeuser && \
    useradd --uid 1001 --gid 1001 --shell /bin/bash --create-home nodeuser

# Crear el directorio job_logs y dar permisos ANTES de cambiar a nodeuser
# Asumimos que esta app también podría generar logs en una carpeta similar.
# Si no usa 'job_logs', puedes omitir esta línea o adaptarla.
RUN mkdir -p ${APP_HOME}/enrichment_logs && \
    chown -R nodeuser:nodeuser ${APP_HOME}/enrichment_logs && \
    chown -R nodeuser:nodeuser ${APP_HOME}

# Cambiar al usuario no-root para la ejecución de la aplicación
USER nodeuser

# Exponer el puerto que tu api_server.js está escuchando (definido por ENV PORT)
EXPOSE ${PORT}

# Comando para correr la aplicación (usando api_server.js)
CMD [ "dumb-init", "node", "api_server.js" ]