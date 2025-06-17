// enrich_website.js
const puppeteerWithStealth = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerWithStealth.use(StealthPlugin());

async function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:99.0) Gecko/20100101 Firefox/99.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/15.3 Safari/537.36',
];

// --- Funciones de Extracción Auxiliares ---

async function extractEmails(page) {
    console.error("[ENRICH-FN] Buscando correos...");
    const emailRegexLenient = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,20}\b/g; // Más permisivo con TLD
    const emailRegexStrict = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
    const foundEmails = new Set();

    try {
        const pageContent = await page.content();
        let emailMatch;
        while ((emailMatch = emailRegexLenient.exec(pageContent)) !== null) {
            if(emailRegexStrict.test(emailMatch[0])) { // Doble check con regex más estricta
                foundEmails.add(emailMatch[0].toLowerCase());
            }
        }

        const mailtoLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href^="mailto:"]'))
                        .map(link => link.getAttribute('href').replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase());
        });
        mailtoLinks.forEach(email => {
            if (email && emailRegexStrict.test(email)) {
               foundEmails.add(email);
            }
        });
    } catch (e) {
        console.error(`[ENRICH-FN-ERROR] Error extrayendo correos: ${e.message}`);
    }
    
    const commonSpamOrServiceDomainsOrKeywords = ['ejemplo@', 'example@', 'wixpress.com', 'godaddy.com', 'cloudflare.', 'protectedemail.com', 'sentry.io', 'localhost', 'javascript:', '.png', '.jpg', '.jpeg', '.gif', 'u002f@', '@example.', '@test.'];
    const filteredEmails = Array.from(foundEmails).filter(email => {
        if (email.length > 100) return false; 
        const emailLowerCase = email.toLowerCase();
        if (commonSpamOrServiceDomainsOrKeywords.some(keyword => emailLowerCase.includes(keyword))) {
            return false;
        }
        return true;
    });
    console.error(`[ENRICH-FN] Correos filtrados: ${filteredEmails.join(', ') || 'Ninguno'}`);
    return filteredEmails;
}

async function extractDescription(page) {
    console.error("[ENRICH-FN] Buscando descripción...");
    let description = null;
    const MAX_DESC_LENGTH = 350;

    try {
        // Prioridad 1: Meta tags
        const metaSelectors = [
            'meta[name="description"]',
            'meta[property="og:description"]',
            'meta[name="twitter:description"]'
        ];
        for (const selector of metaSelectors) {
            try {
                description = await page.$eval(selector, element => element.content.trim());
                if (description) {
                    console.error(`[ENRICH-FN] Descripción encontrada en ${selector}.`);
                    break;
                }
            } catch (e) { /* no encontrado, continuar */ }
        }

        // Prioridad 2: Título de la página (si no es genérico)
        if (!description) {
            let pageTitle = await page.title();
            if (pageTitle && pageTitle.length > 15 && pageTitle.length < 150 && !/inicio|home|página principal|bienvenido|index/i.test(pageTitle.toLowerCase())) {
                description = pageTitle.trim();
                console.error("[ENRICH-FN] Descripción tomada del título de la página.");
            }
        }
        
        // Prioridad 3: Primer párrafo relevante (si aún no hay descripción)
        if (!description) {
            const firstParagraph = await page.evaluate(() => {
                const selectors = ['article p', 'main p', 'div[role="main"] p', 'p']; // Probar varios contenedores
                for (const sel of selectors) {
                    const paragraphs = Array.from(document.querySelectorAll(sel));
                    for (let p of paragraphs) {
                        const text = p.innerText?.trim();
                        if (text && text.length > 70 && text.length < 600) { // Ajustar límites de longitud
                            if (!/copyright|\d{4}|reservados todos los derechos|navegación|menu|subscr[ií]be|newsletter|cookies/i.test(text.toLowerCase())) {
                                return text;
                            }
                        }
                    }
                }
                return null;
            });
            if (firstParagraph) {
                description = firstParagraph;
                console.error("[ENRICH-FN] Descripción tomada del primer párrafo relevante.");
            }
        }

        if (description) {
            description = description.replace(/\s\s+/g, ' ').trim(); // Quitar espacios extra
            if (description.length > MAX_DESC_LENGTH) {
                description = description.substring(0, MAX_DESC_LENGTH - 3) + "...";
            }
        }
    } catch (e) {
        console.error(`[ENRICH-FN-ERROR] Error extrayendo descripción: ${e.message}`);
    }
    console.error(`[ENRICH-FN] Descripción final: ${description || 'No encontrada'}`);
    return description;
}

async function extractPhones(page) {
    console.error("[ENRICH-FN] Buscando teléfonos...");
    const phoneRegexBroad = /(\+?\d{1,4}[\s.-]?)?\(?\d{1,4}\)?[\s.-]?\d{2,5}[\s.-]?\d{2,5}[\s.-]?\d{0,5}/g;
    const potentialPhones = new Set();

    try {
        // Buscar en el texto del cuerpo
        const bodyText = await page.evaluate(() => document.body.innerText);
        let phoneMatch;
        while ((phoneMatch = phoneRegexBroad.exec(bodyText)) !== null) {
            let candidate = phoneMatch[0].trim();
            let numericCandidate = candidate.replace(/[^\d+]/g, '');
            if (numericCandidate.startsWith('+') ? (numericCandidate.length >= 9 && numericCandidate.length <= 17) : (numericCandidate.length >= 7 && numericCandidate.length <= 15)) {
                potentialPhones.add(candidate);
            }
        }

        // Buscar en enlaces tel:
        const telLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href^="tel:"]'))
                        .map(link => link.getAttribute('href').replace(/^tel:/i, '').trim());
        });
        telLinks.forEach(phoneFromLink => {
            let numericCandidate = phoneFromLink.replace(/[^\d+]/g, '');
             if (numericCandidate.startsWith('+') ? (numericCandidate.length >= 9 && numericCandidate.length <= 17) : (numericCandidate.length >= 7 && numericCandidate.length <= 15)) {
                potentialPhones.add(phoneFromLink);
            }
        });
    } catch (e) {
        console.error(`[ENRICH-FN-ERROR] Error extrayendo teléfonos: ${e.message}`);
    }

    if (potentialPhones.size > 0) {
        // Devolver el más largo o el que tenga más dígitos como heurística simple
        const bestPhone = Array.from(potentialPhones).sort((a, b) => b.replace(/[^\d]/g, '').length - a.replace(/[^\d]/g, '').length)[0];
        console.error(`[ENRICH-FN] Teléfono(s) encontrado(s): ${Array.from(potentialPhones).join(' | ')}. Seleccionado: ${bestPhone}`);
        return bestPhone;
    }
    console.error("[ENRICH-FN] Ningún teléfono encontrado en esta página.");
    return null;
}

// --- Función Principal del Script ---
(async () => {
    let browser;
    const output = {
        url_procesada: null,
        correos: [],
        descripcion: null,
        telefono: null,
        error: null
    };

    try {
        const targetUrl = process.argv[2];
        if (!targetUrl) {
            throw new Error("No se proporcionó URL como argumento.");
        }
        output.url_procesada = targetUrl;
        console.error(`[ENRICH] Procesando URL: ${targetUrl}`);

        const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        browser = await puppeteerWithStealth.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu', '--lang=es-ES,es;q=0.9,en;q=0.8'],
            timeout: 90000 // Timeout para el lanzamiento del navegador
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent(randomUserAgent);
        await page.setExtraHTTPHeaders({'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'});
        
        // Opcional: Interceptar requests (descomentar para probar)
        /*
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media', 'other'].includes(req.resourceType())) { // 'other' puede incluir XHR
                req.abort();
            } else {
                req.continue();
            }
        });
        */

        console.error(`[ENRICH] Navegando a ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        console.error(`[ENRICH] Navegación completada para ${targetUrl}`);
        await delay(2000 + Math.random() * 1000);

        // Extracción de la página principal
        output.correos = await extractEmails(page);
        output.descripcion = await extractDescription(page);
        output.telefono = await extractPhones(page);

        // Si no se encontró teléfono en la página principal, intentar buscar en página de "Contacto" o "Ayuda"
        if (!output.telefono) {
            console.error("[ENRICH] Teléfono no encontrado en pág principal. Buscando enlace de 'Contacto/Ayuda'...");
            try {
                const contactPageUrl = await page.evaluate(() => {
                    const linkKeywords = ['contacto', 'ayuda', 'tiendas', 'sucursales', 'atencion al cliente', 'soporte', 'llamanos', 'telefono'];
                    const excludeKeywords = ['preguntas-frecuentes', 'faq', 'blog', 'noticias', 'mapa'];
                    const links = Array.from(document.querySelectorAll('a[href]'));
                    
                    for (const link of links) {
                        const text = (link.innerText || link.textContent || '').toLowerCase().trim();
                        const href = link.href; // URL absoluta
                        
                        if (href && (href.startsWith('http://') || href.startsWith('https://')) && href !== page.url()) { // Url válida y diferente a la actual
                            const hasKeyword = linkKeywords.some(kw => text.includes(kw) || href.includes(kw));
                            const hasExclude = excludeKeywords.some(kw => text.includes(kw) || href.includes(kw));
                            if (hasKeyword && !hasExclude) {
                                return href;
                            }
                        }
                    }
                    return null;
                });

                if (contactPageUrl) {
                    console.error(`[ENRICH] Navegando a página de contacto/ayuda candidata: ${contactPageUrl}`);
                    await page.goto(contactPageUrl, { waitUntil: 'networkidle2', timeout: 45000 });
                    await delay(2000 + Math.random() * 1000);
                    console.error(`[ENRICH] Página de contacto/ayuda cargada. Re-buscando teléfonos...`);
                    output.telefono = await extractPhones(page); // Sobreescribe si encuentra algo
                } else {
                    console.error("[ENRICH] No se encontró un enlace claro a 'Contacto/Ayuda'.");
                }
            } catch (navErr) {
                console.error(`[ENRICH-ERROR] Error durante navegación o búsqueda en página de contacto/ayuda: ${navErr.message.split('\n')[0]}`);
            }
        }

    } catch (err) {
        console.error(`[ENRICH-ERROR-GLOBAL] Error procesando ${output.url_procesada || 'URL desconocida'}: ${err.message.split('\n')[0]}\n${err.stack ? err.stack.substring(0,300) : ''}`);
        output.error = err.message.substring(0, 250);
    } finally {
        if (browser) {
            try {
                await browser.close();
                console.error("[ENRICH] Navegador cerrado.");
            } catch (closeErr) {
                console.error("[ENRICH-ERROR] Error al cerrar el navegador:", closeErr.message);
            }
        }
        process.stdout.write(JSON.stringify(output, null, 2));
        console.error("[ENRICH] Script finalizado.");
    }
})();