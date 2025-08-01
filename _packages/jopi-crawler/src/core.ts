import {WebSiteMirrorCache} from "./webSiteMirrorCache.ts";
import  {UrlMapping} from "./urlMapping.ts";

// @ts-ignore no ts definition
import parseCssUrls from "css-url-parser";
import {applyDefaults, tick} from "./utils.ts";

interface CrawlerTransformUrlInfos {
    /**
     * The local url of the page from which this url has been found.
     */
    comeFromPage: string;

    /**
     * The instance of the crawler.
     */
    crawler: WebSiteCrawler;

    /**
     * If true, this mean we need a final url which is ok with
     * opening the page directly from the file-system.
     */
    requireRelocatableUrl: boolean;
}

interface CrawlerCanIgnoreIfAlreadyCrawled {
    /**
     * At which date the url has been added to the cache.
     */
    addToCacheDate: number;

    /**
     * The url which will be fetched.
     */
    sourceUrl: string;
}

export interface WebSiteCrawlerOptions {
    /**
     * Exclude all url that don't start with this prefix.
     * The default base is the basePath.
     */
    requiredPrefix?: string;

    /**
     * If set, then will save the page inside this directory.
     * Warning: will replace the cache value.
     */
    outputDir?: string;

    /**
     * Is called when an URL is found.
     */
    onUrl?: (url: string, sourceUrl: string) => void;

    /**
     * If defined, then allow rewriting an url found by the HTML analyzer.
     * 
     * @param url
     *      The url found, converted to local site url.
     * @param infos
     *      Information about the context.
     */
    transformUrl?(url: string, infos: CrawlerTransformUrlInfos): string;

    /**
     * Is called when an URL is found and the content is HTML.
     * Allow altering the final HTML.
     */
    onHtml?: (html: string, url: string, sourceUrl: string) => string|Promise<string>;

    /**
     * Allow ignoring an entry if already crawled.
     * The function takes and url (without a base path) and
     * returns true if the page can be ignored, or false if it must crawl.
     */
    canIgnoreIfAlreadyCrawled?: (url: string, infos: CrawlerCanIgnoreIfAlreadyCrawled) => boolean;

    /**
     * Alter the final HTML to make the URL relocatable.
     * This means we can copy and paste the website without attachement to the website name.
     * Default is true.
     */
    requireRelocatableUrl?: boolean;

    /**
     * A list of url which must be replaced.
     * If one of these urls is found as an url prefix,
     * then replace it by the baseUrl.
     */
    rewriteThisUrls?: string[];

    /**
     * A list of forbidden url which must not be crawled.
     * Ex: ["/wp-json"]
     */
    forbiddenUrls?: string[];

    /**
     * A list of urls to scan.
     * Allow including forgotten url (which mainly come from CSS or JavaScript).
     * Ex: ["/my-style.css"].
     */
    scanThisUrls?: string[];

    /**
     * A mapper that allows knowing where to get data.
     * Allow things like:
     *      "/documentation/docA" --> "https://my-docsite.local/documentaiton/docA".
     *      "/blog/my-blog-entry" --> "https://my-blog.local/my-blog-entry".
     */
    urlMapping?: UrlMapping;

    /**
     * The url of the new website, if downloading.
     */
    newWebSiteUrl?: string;

    /**
     * Allow the crawler to do a pause between two call to the server.
     * The default value is 0: no pause.
     */
    pauseDuration_ms?: number;

    /**
     * Is called once a page is entirely downloaded.
     * Will allow stopping the downloading by returning false.
     */
    onPageFullyDownloaded?: (url: string, state: ProcessUrlResult) => void|undefined|boolean|Promise<boolean>;

    /**
     * Is called when a resource is downloaded.
     */
    onResourceDownloaded?(url: string, state: ProcessUrlResult): void;

    /**
     * Allow sorting (and filtering) the pages we must download.
     * The main use case is to prioritize some pages when there is a large breadcrumb/pager/menu.
     */
    sortPagesToDownload?(allUrls: UrlSortTools): void;

    /**
     * Is called when a resource returns a code which isn't 200 (ok) or a redirect.
     * Return true if retry to download, false to stop.
     */
    onInvalidResponseCodeFound?: (url: string, retryCount: number, response: Response) => boolean|Promise<boolean>;

    /**
     * Allows knowing if this url can be downloaded.
     */
    canDownload?(url: string, isResource: boolean): boolean;
}

interface UrlGroup {
    url: string;
    stack?: string[];
}

export enum ProcessUrlResult {
    OK = "ok", REDIRECTED = "redirected", ERROR = "error", IGNORED = "ignored"
}

export class WebSiteCrawler {
    private readonly urlDone: string[] = [];

    private readonly newWebSite_basePath: string;
    private readonly newWebSite_lcBasePath: string;
    private readonly newWebSite_urlInfos: URL;

    private readonly requiredPrefix2: string;

    private rewriter?: HTMLRewriter;
    private isStarted = false;

    private readonly options: WebSiteCrawlerOptions;
    private readonly fileSystemWriter?: WebSiteMirrorCache;

    private currentGroup: UrlGroup = {url:"", stack:[]};
    private readonly groupStack: UrlGroup[] = [];

    /**
     * Create a new crawler instance.
     *
     * @param sourceWebSite
     *      The url of the website to crawl.
     * @param options
     *      Options for complex cases.
     */
    constructor(sourceWebSite: string, options: WebSiteCrawlerOptions) {
        options = applyDefaults(options, {
            requireRelocatableUrl: true,
        });

        options = this.options = {...options};

        let newWebSiteUrl = new URL(options.newWebSiteUrl || sourceWebSite).origin;
        this.newWebSite_basePath = newWebSiteUrl;
        this.newWebSite_lcBasePath = newWebSiteUrl.toLowerCase();

        const urlInfos = new URL(newWebSiteUrl);
        this.newWebSite_urlInfos = urlInfos;

        // Required prefix allows excluding url which are not from our website.
        // It also can be used to exclude a portion of the website.
        //
        if (options.requiredPrefix) {
            options.requiredPrefix = options.requiredPrefix.toLowerCase();
            let idx = options.requiredPrefix.indexOf("://");
            this.requiredPrefix2 = idx === -1 ? options.requiredPrefix : options.requiredPrefix.substring(0, idx + 1);
        } else {
            this.options.requiredPrefix = newWebSiteUrl;
            this.requiredPrefix2 = "//" + urlInfos.hostname;
        }

        let sourceWebSiteOrigin = new URL(sourceWebSite).origin;

        if (sourceWebSiteOrigin!==newWebSiteUrl) {
            if (!options.rewriteThisUrls) options.rewriteThisUrls = [];

            // Allow rewriting the url.
            if (!options.rewriteThisUrls.includes(sourceWebSiteOrigin)) {
                options.rewriteThisUrls.push(sourceWebSiteOrigin);
            }
        }

        // For each url found, url mapping allows to know where we must take our page/resources.
        // It allows combining two or three websites into one.
        //
        if (!options.urlMapping) {
            options.urlMapping = new UrlMapping(sourceWebSite);
        } else {
            if (!options.rewriteThisUrls) options.rewriteThisUrls = [];

            const knownOrigin = options.urlMapping.getKnownOrigins();

            knownOrigin.forEach(origin => {
                if (!options.rewriteThisUrls!.includes(origin)) {
                    options.rewriteThisUrls!.push(origin);
                }
            })
        }

        if (options.outputDir) {
            this.fileSystemWriter = new WebSiteMirrorCache(options.outputDir);
        }

        if (options.forbiddenUrls) {
            options.forbiddenUrls.forEach(url => this.forbidUrlFrom(url));
        }
    }

    /**
     * Start the processing
     */
    public async start(entryPoint?: string) {
        if (!entryPoint) {
            entryPoint = this.newWebSite_basePath;
        }

        const newGroup = {url: entryPoint, stack: []};
        this.groupStack.push(newGroup);
        this.currentGroup = newGroup;

        if (this.options.scanThisUrls) {
            for (let i = 0; i < this.options.scanThisUrls.length; i++) {
                this.pushUrl(this.options.scanThisUrls[i]);
            }
        }

        await this.processStack();
    }

    public forbidUrlFrom(url: string) {
        const cleanedUrl = this._cleanUpUrl(url);

        if (cleanedUrl) {
            if (!this.options.forbiddenUrls) this.options.forbiddenUrls = [];
            this.options.forbiddenUrls.push(cleanedUrl)
        }
    }

    /**
     * Take an url and clean this url.
     * - Resolve relative url.
     * - Exclude special url ("mailto:", "tel:", ...)
     * - Exclude anchor url (starts with #).
     */
    private _cleanUpUrl(url: string | null): string | null {
        return this.cleanUpUrlAux(url, false);
    }

    /**
     * Is like cleanUpUrl but with a special case for CSS.
     *
     * Url in CSS is related to the dir of the CSS file.
     * If I have "myImage.jpg" then it's https//my/css/dir/myImage.jpg.
     */
    private cleanUpCssUrl(url: string, baseUrl: string): string | null {
        return this.cleanUpUrlAux(url, true, baseUrl);
    }

    private cleanUpUrlAux(url: string | null, isCss: boolean, currentUrl?: string): string | null {
        if (!url) return null;

        url = url.trim();
        if (!url) return null;

        if (url[0] === '#') return null;

        // Convert to an absolute url.
        if (!url.includes("://")) {
            if (url[0]==="?") {
                let currentUrl = this.currentGroup.url;
                let idx = currentUrl.indexOf("?");
                if (idx!==-1) currentUrl = currentUrl.substring(0, idx);
                url = currentUrl + url;
            }
            else if (url.includes(":")) {
                if (url.startsWith("data:")) return null;
                if (url.startsWith("javascript:")) return null;
                if (url.startsWith("mailto:")) return null;
                if (url.startsWith("tel:")) return null;
                if (url.startsWith("sms:")) return null;
                if (url.startsWith("ftp:")) return null;
            }

            if (url.startsWith("//")) {
                if (!url.toLowerCase().startsWith(this.requiredPrefix2)) return null;
                url = this.newWebSite_urlInfos.protocol + url;
            } else if (url[0] === "/") {
                url = resolveRelativeUrl(url, this.newWebSite_urlInfos);
            } else {
                if (isCss) {
                    url = resolveRelativeUrl(url, new URL(currentUrl!));
                } else {
                    url = resolveRelativeUrl(url, this.newWebSite_urlInfos);
                }
            }
        } else {
            url = this.rewriteSourceSiteUrl(url);
        }

        if (!url.toLowerCase().startsWith(this.options.requiredPrefix!)) {
            return null;
        }

        return url.trim();
    }

    /**
     * Is called when we want to add an url to the processing queue.
     * A call to cleanUpUrl must have been done before.
     */
    private pushUrl(url: string | null): string {
        if (!url) return "";

        url = this._cleanUpUrl(url);
        if (!url) return "";

        if (this.urlDone.includes(url)) return url;
        this.urlDone.push(url);

        if (this.options.forbiddenUrls) {
            if (this.options.forbiddenUrls.includes(url)) {
                return url;
            }

            const found = this.options.forbiddenUrls.find(prefix => url.startsWith(prefix));
            if (found) return url;
        }

        if (!this.currentGroup.stack) this.currentGroup.stack = [];
        this.currentGroup.stack.push(url);

        //console.log(`Adding url: ${url} (stack ${this.currentGroup.url})`);

        return url;
    }

    private async processStack(): Promise<void> {
        if (this.isStarted) return;
        this.isStarted = true;

        while (true) {
            const group = this.groupStack.shift();
            if (!group) break;

            if (!await this.processGroup(group)) break;
        }

        this.isStarted = false;
    }

    /**
     * Will fetch an url and process the result.
     * If the result is HTML, it will be analyzed.
     * Also, if it's CSS.
     */
    private async processGroup(group: UrlGroup): Promise<boolean> {
        //if (group.stack) console.log("Processing group-n:", group.url);
        //else console.log("Processing group-1:", group.url);

        this.currentGroup = group;

        // Process the group main url.
        const processResponse = await this.processUrl(group.url);

        // Process the resource inside the group.
        if (group.stack) {
            let isResource: string[]|undefined;
            let isNotResource: string[]|undefined;

            group.stack.forEach(url => {
                if (this.isResource(url)) {
                    if (this.options.canDownload) {
                        if (!this.options.canDownload(url, true)) return;
                    }

                    if (!isResource) isResource = [];
                    isResource.push(url);
                } else {
                    if (this.options.canDownload) {
                        if (!this.options.canDownload(url, false)) return;
                    }

                    if (!isNotResource) isNotResource = [];
                    isNotResource.push(url);
                }
            });

            group.stack = undefined;

            // Stack the pages coming from the resources.
            if (isNotResource) {
                if ((isNotResource.length>1) && this.options.sortPagesToDownload) {
                    const sortTools = new UrlSortTools(isNotResource);
                    this.options.sortPagesToDownload(sortTools);
                    isNotResource = sortTools.result();
                }

                isNotResource.forEach(url => {
                    this.groupStack.push({url});
                });
            }

            // Process the resources now.
            // Allow the page to be completely loaded.
            //
            while (isResource) {
                const resources = isResource;
                isResource = undefined;

                for (let i = 0; i < resources.length; i++) {
                    const resUrl = resources[i];
                    //console.log("Processing resource:", resUrl);
                    const resState = await this.processUrl(resUrl);

                    if (this.options.onResourceDownloaded) {
                        this.options.onResourceDownloaded(resUrl, resState);
                    }
                }

                // Come from CSS.
                if (group.stack) {
                    isResource = group.stack;
                    group.stack = undefined;
                }
            }
        }

        if (this.options.onPageFullyDownloaded) {
            const res = this.options.onPageFullyDownloaded(group.url, processResponse);
            if (res instanceof Promise) await res;
            if (res===false) return false;
        }

        return true;
    }

    private isResource(u: string) {
        const url = new URL(u);
        u = url.pathname;

        let idx = u.lastIndexOf(".");
        if (idx===-1) return false;
        let ext = u.substring(idx);

        return gExtensionForResourceType.includes(ext);
    }

    private async processUrl(url: string): Promise<ProcessUrlResult> {
        const partialUrl = url.substring(this.newWebSite_basePath.length);

        const mappingResult = this.options.urlMapping!.resolveURL(partialUrl);
        if (!mappingResult) return ProcessUrlResult.IGNORED;

        let transformedUrl = url;

        if (this.fileSystemWriter) {
            transformedUrl = this.transformFoundUrl(url, false);
        }

        if (this.fileSystemWriter && this.options.canIgnoreIfAlreadyCrawled) {
            const infos = await this.fileSystemWriter.hasInCache(new URL(transformedUrl))

            if (infos && this.options.canIgnoreIfAlreadyCrawled(
                url.substring(this.newWebSite_basePath.length), {
                    addToCacheDate: infos.addedDate,
                    sourceUrl: mappingResult.url
                })) {
                return ProcessUrlResult.IGNORED;
            }
        }

        if (mappingResult.wakeUpServer) {
            await mappingResult.wakeUpServer();
        }

        if (this.options.onUrl) {
            this.options.onUrl(url.substring(this.newWebSite_basePath.length), mappingResult.url);
        }

        if (this.options.pauseDuration_ms) {
            await tick(this.options.pauseDuration_ms);
        }

        let retryCount = 0;

        while (true) {
            let res = await fetch(mappingResult.url, {
                // > This option allows avoiding SSL certificate check.

                // @ts-ignore
                rejectUnauthorized: false,

                requestCert: false,

                tls: {
                    rejectUnauthorized: false,
                    checkServerIdentity: () => { return undefined }
                },

                // Allow avoiding automatic redirections.
                // @ts-ignore
                redirect: 'manual',
            });

            if (res.status !== 200) {
                if (res.status >= 300 && res.status < 400) {
                    const location = res.headers.get("Location");
                    if (location) this.pushUrl(location);
                    return ProcessUrlResult.REDIRECTED;
                } else {
                    let canContinue = false;

                    if (this.options.onInvalidResponseCodeFound) {
                        let what = this.options.onInvalidResponseCodeFound(url, retryCount, res);
                        if (what instanceof Promise) what = await what;
                        canContinue = what;
                    } else if (retryCount<3) {
                        // Retry 3 times, with a longer pause each time.
                        await tick(1000 * retryCount);
                        canContinue = true;
                    }

                    if (!canContinue) {
                        //TODO: use nodeSpace.termColor.GREEN
                        console.error(`!!! Can'! fetch url: ${url} (${res.status})`);
                        return ProcessUrlResult.ERROR;
                    }

                    retryCount++;

                    // Will retry automatically.
                    continue;
                }
            }

            if (retryCount!==0) {
                console.warn("--> Url is now ok: " + url);
            }

            const contentType = res.headers.get("Content-Type");

            if (contentType) {
                if (contentType.startsWith("text/html")) {
                    const content = await res.text();
                    let html = await this.processHtml(content);

                    if (this.options.onHtml) {
                        let res = this.options.onHtml(html, url.substring(this.newWebSite_basePath.length), mappingResult.url);
                        if (res instanceof Promise) res = await res;
                        html = res;
                    }

                    res = new Response(html, {status: 200, headers: res.headers});
                } else if (contentType.startsWith("text/css")) {
                    const content = await res.text();
                    const cssUrls = parseCssUrls(content) as string[];

                    if (cssUrls.length) {
                        cssUrls.forEach(u => {
                            const cleanedUrl = this.cleanUpCssUrl(u, url);
                            if (cleanedUrl) this.pushUrl(cleanedUrl);
                        });
                    }

                    res = new Response(content, {status: 200, headers: res.headers});
                }
            }

            if (this.fileSystemWriter) {
                await this.fileSystemWriter.addToCache(new URL(transformedUrl), res);
            }

            return ProcessUrlResult.OK;
        }
    }

    /**
     * Process an HTML file, which consiste:
     * - Extracting the url.
     * - Replacing this url inside the HTML to convert them.
     */
    private async processHtml(html: string): Promise<string> {
        // Extract all url and rewrite them inside the html.
        // Will emit calls to addUrl for each url found.
        //
        html = this.getRewriter().transform(html);

        return html;
    }

    /**
     * Return the instance of the HTMLRewriter.
     */
    private getRewriter(): HTMLRewriter {
        if (this.rewriter) return this.rewriter;

        const rewriter = new HTMLRewriter();
        this.rewriter = rewriter;

        // >>> Extract url and update them.
        //     The update is only for the final document if he is saved.

        rewriter.on("a, link", {
            element: (node) => {
                let url = node.getAttribute("href");

                if (url) {
                    url = this.pushUrl(url);
                    if (url.length) node.setAttribute("href", this.transformFoundUrl(url));
                }
            }
        });

        // Source: for media.
        rewriter.on("img, script, iframe, source", {
            element: (node) => {
                let url = node.getAttribute("src");

                if (url) {
                    url = this.pushUrl(url);
                    if (url.length) node.setAttribute("src", this.transformFoundUrl(url));
                }
            }
        });

        // For srcset
        rewriter.on("img", {
            element: (node) => {
                let srcset = node.getAttribute("srcset");
                if (!srcset) return;

                const parts = srcset.split(",");
                let newSrcset = "";

                parts.forEach(p => {
                    p = p.trim();
                    const idx = p.indexOf(" ");
                    if (idx === -1) return;

                    let url = p.substring(0, idx);
                    const size = p.substring(idx + 1);

                    let newUrl = this.pushUrl(url);
                    if (url.length) url = newUrl;

                    url = this.transformFoundUrl(url);
                    newSrcset += "," + url + " " + size;
                });

                node.setAttribute("srcset", newSrcset.substring(1));
            }
        });

        return rewriter;
    }

    /**
     * Allow rewriting the url from a source site (where we take our pages)
     *  to transform this url to a local url (our website).
     */
    rewriteSourceSiteUrl(url: string): string {
        if (this.options.rewriteThisUrls) {
            for (let i=0; i<this.options.rewriteThisUrls.length; i++) {
                const prefix = this.options.rewriteThisUrls[i];

                if (url.startsWith(prefix)) {
                    url = this.newWebSite_basePath + url.substring(prefix.length);
                    return url;
                }
            }
        }

        return url;
    }

    /**
     * Allow transforming an url found by the HTML parser.
     */
    transformFoundUrl(url: string, enableRelocatable: boolean = true) {
        if (this.options.transformUrl) {
            url = this.options.transformUrl(url, {
                crawler: this,
                comeFromPage: this.currentGroup.url!,
                requireRelocatableUrl: this.options.requireRelocatableUrl!
            });
        }

        if (enableRelocatable && this.options.requireRelocatableUrl) {
            url = this.urlTool_buildFileSystemUrl(url);
        }

        return url;
    }
    
    /**
     * Clean up the url to make it compatible with the file-system.
     * Will remove the query-string and the anchors part.
     * And make url relatif (with "../.." as a prefix).
     *
     * Why does relatif url are required?
     *      For example, I have a HTML page: file://folderA/webSiteRoot/myPage/index.html
     *          And now a css: /my/css/folder/style.css
     *      Here the final url will be:  file://folderA/webSiteRoot/myPage/my/css/folder/style.css
     *          and not:                 file://folderA/webSiteRoot/my/css/folder/style.css
     *      It's why                     my/css/folder/style.css
     *      must be transformed as    ../my/css/folder/style.css
     *      (only inside this page)
     */
    urlTool_buildFileSystemUrl(url: string): string {
        // Allow to not always check.
        if (!this.options.requireRelocatableUrl) return url;

        let idx = url.indexOf("?");
        if (idx !== -1) url = url.substring(0, idx);

        idx = url.indexOf("#");
        if (idx !== -1) url = url.substring(0, idx);

        // > If not a file, then it a directory.
        //   Transform it to be a /index.html file.

        if (url.endsWith("/")) {
            url += "index.html";
        } else {
            const lastSlash = url.lastIndexOf("/");
            const lastSegment = lastSlash === -1 ? url : url.substring(lastSlash + 1);

            if (!lastSegment.includes(".")) {
                url += "/index.html";
            }
        }

        // Make the url relatif.
        //
        if (url.startsWith(this.newWebSite_lcBasePath)) {
            url = url.substring(this.newWebSite_lcBasePath.length + 1);

            let currentUrl = this.currentGroup.url.substring(this.newWebSite_lcBasePath.length + 1);
            if (!currentUrl) return url;
            if (url === currentUrl) return url;

            let backCount = currentUrl.split("/").length;
            if (currentUrl.endsWith("/")) backCount--;

            for (let i = 0; i < backCount; i++) url = "../" + url;
        }

        return url;
    }
}

function resolveRelativeUrl(url: string, baseUrl: URL): string {
    if (url[0]==="/") {
        if (url[1]==="/") {
            const urlInfos = new URL(url);
            urlInfos.protocol = baseUrl.protocol;
            urlInfos.port = baseUrl.port;
            return urlInfos.toString();
        } else {
            return baseUrl.toString() + url.substring(1);
        }
    } else if (url[0]===".") {
        return new URL(url, baseUrl).toString();
    }

    return url;
}

const gExtensionForResourceType = [
    ".css", ".js", ".jpg", ".png", ".jpeg", ".gif",
    ".woff", ".woff2", ".ttf", ".txt", ".avif"
];


export class UrlSortTools {
    constructor(allUrls: string[]) {
        this.allUrl = allUrls;
    }

    /**
     * Remove the urls for which the filter response true
     * and return an array with the extracted urls.
     */
    remove(filter: (url: string) => boolean): UrlSortTools {
        const removed: string[] = [];
        const others: string[] = [];

        this.allUrl.forEach(url => {
            if (filter(url)) removed.push(url);
             else others.push(url);
        });

        this.removed = removed;
        this.allUrl = others;

        return this;
    }

    sortAsc(): UrlSortTools {
        this.allUrl = this.allUrl.sort();
        return this;
    }

    addRemovedBefore(): UrlSortTools {
        if (!this.removed) return this;
        this.allUrl = [...this.removed, ...this.allUrl];
        this.removed = undefined;
        return this;
    }

    addRemovedAfter(): UrlSortTools {
        if (!this.removed) return this;
        this.allUrl = [...this.allUrl, ...this.removed];
        this.removed = undefined;
        return this;
    }

    result(): string[] {
        return this.allUrl;
    }

    removed?: string[];
    allUrl: string[];
}
