const fs = require("fs");
const path = require("path");
const utils = require("./utils.js");
const LocalCMapReaderFactory = require("./cmap-reader.js");
// HACK few hacks to let PDF.js be loaded not as a module in global space.
if (typeof window === 'undefined' || typeof process === 'object') {
    require("./pdfjs/domstubs.js").setStubs(global);
}
const pdfjsLib = require("./pdfjs/pdf.js");

class PDFExtract {

    constructor() {
    }

    extract(filename, options, cb) {
        if (!cb) {
            return new Promise((resolve, reject) => {
                this.extract(filename, options, (err, data) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(data);
                    }
                })
            });
        }
        fs.readFile(filename, (err, buffer) => {
            if (err) {
                return cb(err);
            }
            return this.extractBuffer(buffer, options, (err, pdf) => {
                if (err) {
                    cb(err);
                } else {
                    pdf.filename = filename;
                    cb(null, pdf);
                }
            });
        });
    }

    extractBuffer(buffer, options = {}, cb) {
        if (!cb) {
            return new Promise((resolve, reject) => {
                this.extractBuffer(buffer, options, (err, data) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(data);
                    }
                })
            });
        }
        // Loading file from file system into typed array
        if (options.verbosity === undefined) {
            // get rid of all warnings in nodejs usage
            options.verbosity = -1;
        }
        if (options.cMapUrl === undefined) {
            options.cMapUrl = path.join(__dirname, "./cmaps/"); // trailing path delimiter is important
        }
        if (options.cMapPacked === undefined) {
            options.cMapPacked = true;
        }
        if (options.CMapReaderFactory === undefined) {
            options.CMapReaderFactory = LocalCMapReaderFactory;
        }
        options.data = new Uint8Array(buffer);
        const pdf = {
            meta: {},
            pages: []
        };

        // Will be using promises to load document, pages and misc data instead of callback.
        pdfjsLib.getDocument(options).promise.then(doc => {
            const firstPage = (options && options.firstPage) ? options.firstPage : 1;
            const lastPage = Math.min((options && options.lastPage) ? options.lastPage : doc.numPages, doc.numPages);
            pdf.pdfInfo = doc.pdfInfo;
            const promises = [
                doc.getMetadata().then(data => {
                    pdf.meta = { info: data.info, metadata: data.metadata ? data.metadata.getAll() || null : null };
                })
            ];
            const loadPage = pageNum => doc.getPage(pageNum).then(async page => {
                let combinedContent = '';
                const viewport = page.getViewport({ scale: 1.0 });
                const pag = {
                    pageInfo: {
                        num: pageNum,
                        scale: viewport.scale,
                        rotation: viewport.rotation,
                        offsetX: viewport.offsetX,
                        offsetY: viewport.offsetY,
                        width: viewport.width,
                        height: viewport.height
                    }
                };
                pdf.pages.push(pag);
                const normalizeWhitespace = !!(options && options.normalizeWhitespace === true);
                const disableCombineTextItems = !!(options && options.disableCombineTextItems === true);
                // Get the text content
                try {
                    const textContent = await page.getTextContent({ normalizeWhitespace, disableCombineTextItems });

                    // Get the annotations (links)
                    const annotations = await page.getAnnotations();

                    // Create a mapping of annotation positions to their URLs
                    const linkItems = annotations
                        .filter((annotation) => annotation.subtype === 'Link' && annotation.url)
                        .map((annotation) => {
                            return {
                                url: annotation.url,
                                rect: annotation.rect
                            };
                        });

                    // Combine text and links based on their positions
                    const combinedItems = [];

                    let currentLink = null;

                    textContent.items.forEach((item, index) => {
                        const [x, y] = [item.transform[4], item.transform[5]];
                        const matchingLink = linkItems.find((linkItem) => {
                            const [x1, y1, x2, y2] = linkItem.rect;
                            return x >= x1 && x <= x2 && y >= y1 && y <= y2;
                        });

                        const itemText = item.str.trim();
                        const previousItem = textContent.items[index - 1];

                        // Check if the item starts a new line
                        const isNewLine =
                            previousItem && previousItem.transform[5] !== item.transform[5];

                        if (isNewLine) {
                            if (currentLink) {
                                combinedItems.push('</a>');
                                currentLink = null;
                            }
                            combinedItems.push('\n');
                        }

                        if (matchingLink) {
                            if (currentLink === matchingLink.url) {
                                combinedItems.push(itemText);
                            } else {
                                if (currentLink) {
                                    combinedItems.push('</a>');
                                }
                                currentLink = matchingLink.url;
                                combinedItems.push(`<a href="${currentLink}">${itemText}`);
                            }
                        } else {
                            if (currentLink) {
                                combinedItems.push('</a>');
                                currentLink = null;
                            }
                            combinedItems.push(itemText);
                        }
                    });

                    if (currentLink) {
                        combinedItems.push('</a>');
                    }


                    combinedContent += combinedItems.join(' ') + '\n';

                    pag.content = combinedContent;

                } catch (err) {
                    cb(err);
                }
            });
            for (let i = firstPage; i <= lastPage; i++) {
                promises.push(loadPage(i));
            }
            return Promise.all(promises);
        }).then(() => {
            pdf.pages.sort((a, b) => a.pageInfo.num - b.pageInfo.num);
            cb(null, pdf);
        }, (err) => {
            cb(err)
        });
    }
}

PDFExtract.utils = utils;

module.exports.PDFExtract = PDFExtract;
