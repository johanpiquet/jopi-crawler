import {WebSiteCrawler} from "jopi-crawler";

//const websiteToScan = "https://my-jopi-web-site.jopi:8890";
const websiteToScan = "https://my-jopi-web-site.jopi:8890";

const crawler = new WebSiteCrawler(websiteToScan, {
    // onUrl is called every time an URL is found.
    // Here we use it to log which url is resolved which what.
    onUrl(url: string, _fullUrl: string) {
        console.log("onUrl:", url);
    }
});

await crawler.start();
console.log("Finished crawling !");