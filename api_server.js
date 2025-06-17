// api_server.js

// --- Dependencias ---
const express = require('express');
const puppeteerWithStealth = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerWithStealth.use(StealthPlugin());

// --- Constantes y Funciones Auxiliares Globales ---
async function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.5005.63 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:101.0) Gecko/20100101 Firefox/101.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.5005.61 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/15.5 Safari/537.36',
];

// --- Funciones de Extracción ---
// (Tu código de extractEmails, extractDescription, extractPhones permanece igual)
async function extractEmails(page) {
    console.error("[ENRICH-FN] Buscando correos...");
    const emailRegexLenient = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,20}\b/g;
    const emailRegexStrict = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
    const foundEmails = new Set();

    try {
        const pageContent = await page.content();
        let emailMatch;
        while ((emailMatch = emailRegexLenient.exec(pageContent)) !== null) {
            if(emailRegexStrict.test(emailMatch[0])) {
                foundEmails.add(emailMatch[0].toLowerCase());
            }
        }
        const mailtoLinks = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a[href^="mailto:"]'))
                 .map(link => link.getAttribute('href').replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase())
        );
        mailtoLinks.forEach(email => {
            if (email && emailRegexStrict.test(email)) foundEmails.add(email);
        });
    } catch (e) { console.error(`[ENRICH-FN-ERROR] Error extrayendo correos: ${e.message.split('\n')[0]}`); }

    const commonSpamOrServiceDomainsOrKeywords = ['ejemplo@', 'example@', '@example.', '@test.', 'wixpress.com', 'godaddy.com', 'cloudflare.', 'protectedemail.com', 'sentry.io', 'localhost', 'javascript:', '.png', '.jpg', '.jpeg', '.gif', 'u002f@', ' राय@', 'email@example.com', 'info@domain.com'];
    const filteredEmails = Array.from(foundEmails).filter(email =>
        email.length < 100 && !commonSpamOrServiceDomainsOrKeywords.some(keyword => email.toLowerCase().includes(keyword)) && emailRegexStrict.test(email)
    );
    console.error(`[ENRICH-FN] Correos filtrados: ${filteredEmails.join(', ') || 'Ninguno'}`);
    return filteredEmails;
}

async function extractDescription(page) {
    console.error("[ENRICH-FN] Buscando descripción ampliada...");
    let descriptionParts = new Set();
    const MAX_DESC_LENGTH = 500;
    const MIN_PART_LENGTH = 60;

    try {
        const metaSelectors = ['meta[property="og:description"]', 'meta[name="description"]', 'meta[name="twitter:description"]'];
        for (const selector of metaSelectors) {
            try {
                const metaDesc = await page.$eval(selector, element => element.content.trim());
                if (metaDesc && metaDesc.length > MIN_PART_LENGTH / 3) {
                    descriptionParts.add(metaDesc.trim());
                    if (metaDesc.length > 250 && descriptionParts.size >=1) break; 
                }
            } catch (e) { /* no encontrado */ }
        }

        let currentDescTextLength = Array.from(descriptionParts).join(" ").length;

        if (currentDescTextLength < 150) {
            const aboutText = await page.evaluate((minLenArg) => {
                const keywords = ['acerca de nosotros', 'quiénes somos', 'nuestra empresa', 'nuestra historia', 'sobre nosotros', 'nuestra misión', 'nuestra visión', 'la compañía', 'el equipo'];
                const elementsToSearch = Array.from(document.querySelectorAll('h1, h2, h3, h4, section, div[class*="about"], div[id*="about"], article'));
                let collectedText = "";
                for(const el of elementsToSearch) {
                    if (el.closest('nav, footer, header, .header, .footer, .sidebar, .widget, .modal, form')) continue;
                    const elTextContent = el.innerText || el.textContent || '';
                    const elTextLower = elTextContent.toLowerCase().trim();

                    if (keywords.some(kw => elTextLower.includes(kw))) {
                        let parentContainer = el.closest('section, div, article') || el.parentElement;
                        let textBuffer = "";
                        let pCount = 0;
                        if (parentContainer) {
                            const paragraphs = Array.from(parentContainer.querySelectorAll('p'));
                            for (const p of paragraphs) {
                                const pText = (p.innerText || p.textContent || '').trim();
                                if (pText && pText.length > minLenArg && textBuffer.length < 450 && pCount < 3) {
                                    textBuffer += pText + " ";
                                    pCount++;
                                }
                                if (textBuffer.length >= 450 || pCount >=3) break;
                            }
                        }
                        if (textBuffer.trim()) {
                            collectedText = textBuffer.trim();
                            break;
                        }
                    }
                }
                return collectedText || null;
            }, MIN_PART_LENGTH);
            if (aboutText) descriptionParts.add(aboutText.trim());
        }

        currentDescTextLength = Array.from(descriptionParts).join(" ").length;
        if (currentDescTextLength < MAX_DESC_LENGTH / 1.5) {
             const mainContentParagraphs = await page.evaluate((minLenArg, maxTotalLenArg) => {
                const mainSelectors = ['article p', 'main p', 'div[role="main"] p', '.content p', '.entry-content p', 'div[class*="content"] p', 'div[id*="content"] p'];
                let text = "";
                let pCount = 0;
                for (const sel of mainSelectors) {
                    const elements = Array.from(document.querySelectorAll(sel));
                    for (const p of elements) {
                         const pText = (p.innerText || p.textContent || '').trim();
                         if (pText && pText.length > minLenArg && text.length < maxTotalLenArg && pCount < 3) {
                             const pTextLower = pText.toLowerCase();
                             if (!/copyright|©|\d{4} \w+|reservados todos los derechos|navegación|menu|subscr|newsletter|cookies|pol[ií]tica de privacidad|t[eé]rminos y condiciones|aviso legal|leer m[aá]s|ver m[aá]s|precio|oferta|descuento|impuestos incluidos|iva incluido|categor[ií]as|productos relacionados|comentarios de clientes|valoraciones/i.test(pTextLower) &&
                                 !p.closest('nav, footer, header, aside, .sidebar, .menu, .footer, .site-footer, .widget-area, .comments, .related-posts, form, .breadcrumbs, .pagination')) {
                                text += pText + " ";
                                pCount++;
                                if (text.length >= maxTotalLenArg || pCount >=3) break;
                             }
                         }
                    }
                    if (text.length >= maxTotalLenArg || pCount >=3) break;
                }
                return text.trim() || null;
            }, MIN_PART_LENGTH, MAX_DESC_LENGTH - currentDescTextLength);
            if (mainContentParagraphs) descriptionParts.add(mainContentParagraphs.trim());
        }

        currentDescTextLength = Array.from(descriptionParts).join(" ").length;
        if (currentDescTextLength < MIN_PART_LENGTH * 1.5 && currentDescTextLength > 0) {
        } else if (currentDescTextLength === 0) { 
            let pageTitle = await page.title();
            if (pageTitle && pageTitle.length > 10 && pageTitle.length < 150 ) {
                const titleLower = pageTitle.toLowerCase();
                if (!/inicio|home|página principal|index|bienvenido|search results|buscar/i.test(titleLower)) {
                    descriptionParts.add(pageTitle.trim());
                }
            }
        }

        let finalDescription = Array.from(descriptionParts).filter(p => p && p.trim() !== "").join(" ... ");
        finalDescription = finalDescription.replace(/\s\s+/g, ' ').replace(/(\r\n|\n|\r)/gm," ").trim();
        if (finalDescription.length > MAX_DESC_LENGTH) finalDescription = finalDescription.substring(0, MAX_DESC_LENGTH - 3) + "...";
        else if (finalDescription.length === 0) finalDescription = null;

        console.error(`[ENRICH-FN] Descripción final ensamblada (longitud ${finalDescription ? finalDescription.length : 0}): ${finalDescription ? finalDescription.substring(0,100) + "..." : 'No encontrada'}`);
        return finalDescription;

    } catch (e) { console.error(`[ENRICH-FN-ERROR] Error extrayendo descripción: ${e.message.split('\n')[0]}`); return null; }
}

async function extractPhones(page) {
    console.error("[ENRICH-FN] Buscando teléfonos...");
    const phoneRegexBroad = /(\+?\d{1,4}[\s.-]?)?((\(\s*\d{1,4}\s*\))|(\d{1,4}))?[\s.-]?\d{2,5}[\s.-]?\d{2,5}([\s.-]?\d{2,5})?/g;
    const potentialPhones = new Set();
    try {
        const bodyText = await page.evaluate(() => document.body.innerText || document.body.textContent || "");
        let phoneMatch;
        while ((phoneMatch = phoneRegexBroad.exec(bodyText)) !== null) {
            let candidate = phoneMatch[0].trim();
            let numericCandidate = candidate.replace(/[^\d+]/g, '');
            if (numericCandidate.startsWith('+') ? (numericCandidate.length >= 9 && numericCandidate.length <= 18) : (numericCandidate.length >= 7 && numericCandidate.length <= 16)) {
                if (candidate.replace(/[\s().+-]/g, '').length < 15 && /\D/.test(candidate) || candidate.length < 15) { 
                    potentialPhones.add(candidate);
                }
            }
        }
        const telLinks = await page.evaluate(() => Array.from(document.querySelectorAll('a[href^="tel:"]')).map(link => link.getAttribute('href').replace(/^tel:/i, '').trim()));
        telLinks.forEach(phoneFromLink => {
            let numericCandidate = phoneFromLink.replace(/[^\d+]/g, '');
            if (numericCandidate.startsWith('+') ? (numericCandidate.length >= 9 && numericCandidate.length <= 18) : (numericCandidate.length >= 7 && numericCandidate.length <= 16)) {
                potentialPhones.add(phoneFromLink);
            }
        });
    } catch (e) { console.error(`[ENRICH-FN-ERROR] Error extrayendo teléfonos: ${e.message.split('\n')[0]}`); }

    if (potentialPhones.size > 0) {
        const bestPhone = Array.from(potentialPhones)
            .map(p => ({ original: p, numeric: p.replace(/[^\d]/g, '') }))
            .sort((a, b) => b.numeric.length - a.numeric.length)[0];

        console.error(`[ENRICH-FN] Teléfono(s) encontrado(s): ${Array.from(potentialPhones).join(' | ')}. Seleccionado: ${bestPhone.original}`);
        return bestPhone.original;
    }
    console.error("[ENRICH-FN] Ningún teléfono encontrado en esta página.");
    return null;
}


// --- Lógica Principal de Enriquecimiento (llamada por la API) ---
async function runEnrichment(targetUrl) {
    let browser;
    const output = {
        url_procesada: targetUrl,
        correos: [],
        descripcion: null,
        telefono: null,
        error: null
    };

    try {
        console.error(`[API-ENRICH] Iniciando enriquecimiento para: ${targetUrl}`);
        const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

        browser = await puppeteerWithStealth.launch({
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
                '--disable-gpu', '--lang=es-ES,es;q=0.9,en;q=0.8',
                '--blink-settings=imagesEnabled=false'
            ],
            timeout: 90000
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent(randomUserAgent);
        await page.setExtraHTTPHeaders({'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'});

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['stylesheet', 'font', 'image', 'media'].includes(resourceType)) { 
                req.abort();
            } else {
                req.continue();
            }
        });

        console.error(`[API-ENRICH] Navegando a ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        console.error(`[API-ENRICH] Navegación completada para ${targetUrl}`);
        await delay(1500 + Math.random() * 1000);

        output.correos = await extractEmails(page);
        output.descripcion = await extractDescription(page);
        output.telefono = await extractPhones(page);

        if (!output.telefono) {
            console.error("[API-ENRICH] Teléfono no encontrado en pág principal. Buscando enlace de 'Contacto/Ayuda'...");
            try {
                const currentPageUrlForEval = page.url(); 
                console.error(`[API-ENRICH-DEBUG] URL actual antes de buscar enlace de contacto: ${currentPageUrlForEval}`);

                const contactPageUrl = await page.evaluate((currentPUrl) => { 
                    console.log('[BROWSER-CONSOLE] Buscando enlace de contacto/ayuda...');
                    const linkKeywords = ['contacto', 'ayuda', 'tiendas', 'sucursales', 'atencion al cliente', 'soporte', 'llamanos', 'telefono', 'contactanos', 'contact us', 'ubicaciones', 'escríbenos'];
                    const excludeKeywords = ['preguntas-frecuentes', 'faq', 'blog', 'noticias', 'mapa', 'politica', 'terminos', 'privacidad', 'trabaja con nosotros', 'empleo', 'carrera', 'inversionistas', 'newsletter', 'aviso legal'];
                    const links = Array.from(document.querySelectorAll('a[href]'));
                    let candidateLinks = [];

                    for (const link of links) {
                        const text = (link.innerText || link.textContent || '').toLowerCase().trim();
                        const href = link.href;

                        if (href && (href.startsWith('http://') || href.startsWith('https://')) && href !== currentPUrl && !href.endsWith('#') && !href.startsWith('javascript:') && href.length < 250) {
                            const hasKeyword = linkKeywords.some(kw => text.includes(kw) || href.toLowerCase().includes(kw));
                            const hasExclude = excludeKeywords.some(kw => text.includes(kw) || href.toLowerCase().includes(kw));
                            if (hasKeyword && !hasExclude) {
                                candidateLinks.push({url: href, priority: (text.includes('contacto') || text.includes('ayuda') || text.includes('contactanos') ? 1 : 2), text: text});
                            }
                        }
                    }
                    if (candidateLinks.length > 0) {
                        candidateLinks.sort((a, b) => {
                            if (a.priority !== b.priority) return a.priority - b.priority;
                            return a.text.length - b.text.length;
                        });
                        console.log('[BROWSER-CONSOLE] Enlace de contacto candidato seleccionado:', candidateLinks[0].url);
                        return candidateLinks[0].url;
                    }
                    console.log('[BROWSER-CONSOLE] No se encontraron enlaces candidatos de contacto/ayuda.');
                    return null;
                }, currentPageUrlForEval); 

                console.error(`[API-ENRICH-DEBUG] page.evaluate para contactPageUrl completado. contactPageUrl = ${contactPageUrl}`);

                if (contactPageUrl) {
                    console.error(`[API-ENRICH] Navegando a página de contacto/ayuda candidata: ${contactPageUrl}`);
                    if (!page || typeof page.goto !== 'function' || page.isClosed()) {
                        console.error("[API-ENRICH-FATAL-DEBUG] ¡El objeto 'page' de Puppeteer no es válido o está cerrado antes de page.goto(contactPageUrl)!");
                        throw new Error("Objeto 'page' de Puppeteer inválido/cerrado antes de sub-navegación.");
                    }
                    await page.goto(contactPageUrl, { waitUntil: 'networkidle2', timeout: 45000 });
                    await delay(1500 + Math.random() * 1000);
                    console.error(`[API-ENRICH] Página de contacto/ayuda cargada: ${page.url()}. Re-buscando teléfonos...`);
                    const phoneFromContactPage = await extractPhones(page);
                    if (phoneFromContactPage) {
                        output.telefono = phoneFromContactPage;
                        console.error(`[API-ENRICH] Teléfono encontrado en página de contacto/ayuda: ${output.telefono}`);
                    } else {
                         console.error(`[API-ENRICH] No se encontraron teléfonos en la página de contacto/ayuda visitada.`);
                    }
                } else {
                    console.error("[API-ENRICH] No se encontró un enlace claro a 'Contacto/Ayuda' en la página principal.");
                }
            } catch (navErr) {
                console.error(`[API-ENRICH-ERROR] Error en lógica de sub-navegación: ${navErr.message.split('\n')[0]}`);
            }
        }

    } catch (err) {
        console.error(`[API-ENRICH-ERROR-GLOBAL] Error en runEnrichment para ${targetUrl}: ${err.message.split('\n')[0]}`);
        output.error = err.message.substring(0, 250);
    } finally {
        if (browser) {
            try {
                if (!browser.isConnected()) {
                    console.error("[API-ENRICH-WARN] El navegador ya no estaba conectado antes de intentar cerrar.");
                } else {
                    await browser.close();
                    console.error("[API-ENRICH] Navegador cerrado para", targetUrl);
                }
            }
            catch (closeErr) { console.error("[API-ENRICH-ERROR] Error al cerrar navegador:", closeErr.message.split('\n')[0]); }
        }
    }
    return output;
}


// --- Configuración del Servidor Express ---
const app = express();
const port = process.env.PORT || 3002;

app.use(express.json()); // << NUEVO: Para parsear el body de solicitudes POST como JSON

// RUTA POST PARA ENRIQUECIMIENTO (n8n llamará a esta) // << NUEVO
app.post('/', async (req, res) => {
    const urlToScrape = req.body.url; // Esperamos que n8n envíe {"url": "http://..."}

    console.log(`[API] Solicitud POST recibida para enriquecer URL: ${urlToScrape}`);

    if (!urlToScrape) {
        console.error('[API-ERROR] Parámetro "url" no encontrado en el body.');
        return res.status(400).json({ error: 'Parámetro "url" es requerido en el body.' });
    }
    if (typeof urlToScrape !== 'string' || (!urlToScrape.startsWith('http://') && !urlToScrape.startsWith('https://'))) {
        console.error(`[API-ERROR] URL inválida recibida: ${urlToScrape}`);
        return res.status(400).json({ error: 'URL inválida. Debe ser una cadena y empezar con http:// o https://' });
    }

    try {
        const result = await runEnrichment(urlToScrape);
        console.log(`[API] Enriquecimiento procesado para: ${urlToScrape}. Error en result: ${result.error || 'No'}`);
        res.status(200).json(result);
    } catch (e) {
        console.error(`[API-FATAL] Error fatal en endpoint POST /: ${e.message.split('\n')[0]}`);
        res.status(500).json({ 
            url_procesada: urlToScrape, 
            error: 'Error interno del servidor al procesar la solicitud.', 
            details: e.message.substring(0,100), 
            correos: [], 
            descripcion: null, 
            telefono: null 
        });
    }
});

// Ruta GET que tenías (se mantiene, útil para pruebas básicas del túnel)
app.get('/', (req, res) => { // << MODIFICADO: Cambiado de '/enrich' a '/' si n8n llama a la raíz con GET para prueba
    res.send('API de Enriquecimiento funcionando OK! (GET request a /)');
});
// Si tu ruta GET anterior era importante y distinta, puedes mantenerla:
// app.get('/enrich', async (req, res) => { ... tu código GET anterior ... });


app.use((err, req, res, next) => {
  console.error("[EXPRESS-ERROR-HANDLER]", err.stack);
  if (!res.headersSent) {
    res.status(500).send('Algo salió muy mal en el servidor!');
  }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`API de enriquecimiento escuchando en http://0.0.0.0:${port}`);
});