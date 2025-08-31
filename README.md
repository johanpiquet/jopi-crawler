# Jopi Crawler

## What is a crawler?

A crawler is a tool that scans all the pages of a website, it browses the entire site to extract information. Jopi Rewrite includes a particularly powerful crawler, capable of analyzing both HTML and CSS. This allows it to find all the pages of the website and all the resources linked to that site.

This crawler can be used for many purposes. However, it has been designed to efficiently address these three use cases:

* **Create a list of all valid URLs for a website.**  
  Knowing this is interesting from a security perspective because it allows us to ban other URLs. This way, we protect our site against access to resources that should not be accessible by filtering what is authorized and what is not.

* **Create a static version of a website by downloading all its pages.**  
  The crawler can directly store the found pages and resources as a tree structure of files and folders reflecting the structure of the site, while making their URLs relocatable: independent of the website's domain name.

* **Analyze dependencies between pages.**  
  For example, to know which pages should be removed from the cache when a product is modified on an e-commerce site.

## Extracting URLs

Here is an example showing how to use the crawler to extract all the URLs from a website.

```typescript
import {WebSiteCrawler} from "jopi-crawler";

const websiteToScan = "https://my-web-site";

const crawler = new WebSiteCrawler(websiteToScan, {
    // onUrl is called every time a URL is found.
    // Here we use it to log which URL is resolved with what.
    onUrl(url: string, _fullUrl: string) {
        console.log("onUrl:", url);
    }
});

await crawler.start();
```

## Downloading a website

This example shows you how to download a website and convert it to a relocatable
website, which means that this website has no references to the original website:
all URLs are converted and transformed into something independent, which can be
browsed from the file system (directly opening the HTML stored on disk).

```typescript
const websiteToScan = "https://my-web-site";

const crawler = new WebSiteCrawler(websiteToScan, {
    // Where to store our flat website.
    // When you set an outputDir, the crawler automatically stores the pages.
    outputDir: "./downloadedWebSite",

    // Allow tracing progression.
    onUrl(url: string) { console.log("Processing url:", url) },

    // I don't want to scan URLs starting with /wp-json.
    forbiddenUrls: ["/wp-json"],
});

await crawler.start();
```

Now a sample showing you how to serve this website.

```typescript
import {getServer, WebSite} from "jopi-crawler";

const server = getServer();
const myWebSite = server.addWebsite(new WebSite("http://127.0.0.1"));
myWebSite.onGET("/**", req => req.serveFile("./downloadedWebSite"));
server.startServer();
```

## Advanced sample

This example shows several advanced possibilities offered by the crawler,
notably the ability to download a website by combining several sources.

Here we will combine two sources:
* Pages coming from a local WordPress instance.
* Pages coming from a Docusaurus server (/documentation/*).

We will also do several interesting things:
* Start my Docusaurus server when the crawler scans its pages, then automatically shut it down.
* Avoid scanning already seen pages again, except for some key pages.
* Modify HTML pages to add a comment indicating the cache date.

```typescript
import {AutomaticStartStop, ONE_DAY, startApplication} from "jopi-rewrite";
import {UrlMapping, WebSiteCrawler } from "jopi-crawler";

import * as path from "node:path";

// Where to store our flat website.
const outDir = "../flat-website";

// Where is my WordPress server.
const myLocalWordpressUrl = "https://my-jopi-web-site.jopi:8890";
// Where is my Docusaurus server.
const myDocusaurusUrl = "http://localhost:3001";

// Will wake up my Docusaurus server.
//
// AutomaticStartStop allows starting a server on the first request.
// And shutting it down if it isn't requested anymore,
// after a delay of n-minutes. Also, it automatically shuts down
// the server when our application exits (which is what we want here).
//
const wakeUpDocServer = new AutomaticStartStop({
    // Only for logs.
    name: "Doc server",

    async onStart(data: any) {
        // Where is my server script.
        const workingDir = path.join(process.cwd(), "..", "..", "__MyProjectsDoc");
        // Build the doc.
        await Bun.spawn(["bun", "run", "build"], {cwd: workingDir}).exited;
        // Serve it
        const myProcess = Bun.spawn(["bun", "run", "serve"], {cwd: workingDir});
        // Allow onStop to get the reference.
        data.startProcess = myProcess;
    },

    async onStop(data: any) {
        // Get the reference to myProcess.
        const myProcess = data.startProcess as Bun.Subprocess;
        // Kill the process.
        myProcess.kill();
    }
});

async function launchCrawler() {
    // urlMapping allows the crawler to know which site it must crawl.
    const urlMapping = new UrlMapping(
        // If the url is not resolved, then must default to this.
        myLocalWordpressUrl
    );

    // Map URLs starting with /documentation to my Docusaurus server.
    //
    // Here we add a function which is called every time
    // one of these URLs is used (wakeUpDocServer.start())
    // It allows starting our server:
    // - The first call starts up our server.
    // - The other calls, says that the doc server remains useful.
    urlMapping.mapURL("/documentation",
        myDocusaurusUrl, () => wakeUpDocServer.start());

    // Create the crawler instance.
    const crawler = new WebSiteCrawler(myLocalWordpressUrl, {
        // Where to store our flat website.
        outputDir: outDir,

        // Allow seeing what it's doing.
        onUrl(url: string) {
            console.log("Processing url:", url);
        },

        // Allow removing /index.html from the links.
        // If the URL is http://127.0.0.1/my/dir/index.html,
        // then transform it to http://127.0.0.1/my/dir/.
        transformUrl(url: string) {
            if (url==="index.html") return "/";

            if ((url==="index.html") || url.endsWith("/index.html")) {
                return url.slice(0, -10);
            }

            return url;
        },

        // onHtml allows analyzing and altering the HTML.
        // Here we add an "Added to cache" message.
        onHtml(html: string): string {
            return html + "<!-- Added to cache at " 
                        + new Date().toISOString() 
                        + " -->";
        },

        // Avoid crawling again if already crawled.
        // Here only the important pages will be crawled again.
        canIgnoreIfAlreadyCrawled: (url, infos) => {
            // Don't scan again if it's less than one day.
            if ((Date.now() - infos.addToCacheDate)<ONE_DAY) return true;

            // Is it my blog entry page? Then scan again.
            if ((url==="/blog") || url.startsWith("/blog/")) {
                // Will crawl the blog page.
                // Allow checking blog new entries which aren't in the cache.
                return false;
            }

            // Don't scan again if it's another page.
            return true;
        },

        // I don't want to scan URLs starting with /wp-json.
        forbiddenUrls: ["/wp-json"],

        // URL mapper. Allows knowing where to find our page and resources to crawl.
        urlMapping: urlMapping,

        // Allow adding URLs which are forgotten.
        //
        // Why forgotten?
        // - They come from JavaScript.
        // - They come from complex CSS.
        scanThisUrls: [
            "/wp-content/uploads/2022/04/lottie-home-lottie1.json",
            "/wp-content/uploads/2022/04/lottie-home-lottie2.json",
            "/wp-content/uploads/2022/04/lottie-home-lottie3.json",
            "/wp-content/uploads/2022/04/lottie-body-bg.webp",

            "/wp-content/themes/betheme/fonts/fontawesome/fa-brands-400.woff2",
            "/wp-content/themes/betheme/fonts/fontawesome/fa-brands-400.woff",
            "/wp-content/themes/betheme/fonts/fontawesome/fa-brands-400.ttf",

            // Adding these URLs is required for canIgnoreIfAlreadyCrawled.
            // Why? Because if pages leading to /blog or /documentation
            // are not crawled, then it will never try to crawl again our two pages.
            "/blog",
            "/documentation",
        ],

        // I have some raw URLs inside my website. They must be converted.
        // That's what rewriteThisUrls allows: it converts these URLs
        // as if they were part of our website URL.
        rewriteThisUrls: [
            "https://johan-piquet.fr"
        ]
    });

    await crawler.start()

    console.log("Finished crawling!");
}

// startApplication allows automatically stopping
// things when the application exits or on [Ctrl]+[C].
// Here we need to use it because we have AutomaticStartStop.
startApplication(launchCrawler);

console.log("Crawl finished");
```