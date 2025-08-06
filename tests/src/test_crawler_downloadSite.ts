import {ProcessUrlResult, tick, WebSiteCrawler} from "jopi-crawler";

const outDir = "../../flat-website";
const webSiteUrl = "https://developer.mozilla.org/";

const crawler = new WebSiteCrawler(webSiteUrl, {
    outputDir: outDir,

    transformUrl(url) {
        if (url.includes("/?page=")) {
            url = url.replace("/?page=", "/index_page_");
        }

        return url;
    },

    onResourceDownloaded(url, state) {
        if (state===ProcessUrlResult.IGNORED) return true;
        console.log("Resource downloaded:", url);
    },

    onPageFullyDownloaded(url, state) {
        if (state===ProcessUrlResult.IGNORED) return true;
        console.log("Page fully downloaded:", url);
        return true;
    },

    /*sortPagesToDownload(sortTools) {
        sortTools.remove(url => {
            return url.includes("/transcripts/?")
        });

        sortTools.addRemovedBefore();
    },*/

    async onInvalidResponseCodeFound(url, retryCount, res) {
        console.log("Invalid response code (" + retryCount + "):", url, res.status, res.statusText);
        if (retryCount>3) return false;
        await tick(1500 * retryCount);
        return true;
    },

    /*canDownload(_url, isResource) {
        return true;
    },*/

    canIgnoreIfAlreadyCrawled(url) {
        //if (url==="/transcripts/") return false;
        return true;
    },

    //pauseDuration_ms: 1000,
});

await crawler.start()
console.log("Finished crawling !");