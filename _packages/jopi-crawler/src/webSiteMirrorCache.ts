import path from "node:path";
import fs from "node:fs/promises";

export class WebSiteMirrorCache {
    public readonly rootDir: string;

    constructor(rootDir: string) {
        if (!rootDir) rootDir = ".";
        if (!path.isAbsolute(rootDir)) rootDir = path.resolve(process.cwd(), rootDir);
        this.rootDir = rootDir;
    }

    private calKey(url: URL): string {
        url = new URL(url);
        url.hostname = "localhost";
        url.port = "";
        url.protocol = "file:";

        const sURL = url.toString();
        return Bun.fileURLToPath(sURL);
    }

    private calcFilePath(url: URL): string {
        let fp = path.join(this.rootDir, this.calKey(url));

        if (fp.endsWith("/")) {
            fp += "index.html";
        } else {
            const ext = path.extname(fp);
            if (!ext) fp += "/index.html";
        }

        return fp;
    }

    async addToCache(url: URL, response: Response): Promise<Response> {
        // We don't store 404 and others.
        if (response.status !== 200) return response;

        const filePath = this.calcFilePath(url);
        await fs.mkdir(path.dirname(filePath), {recursive: true});

        try {
            const file = Bun.file(filePath);
            await file.write(response);

            const headers: any = {
                "content-type": file.type,
                "content-length": file.size.toString()
            };

            return new Response(file, {status: 200, headers});
        }
        catch (e) {
            console.error(e);
            return new Response("", {status: 500});
        }
    }

    async hasInCache(url: URL): Promise<undefined|{addedDate: number, filePath: string}> {
        const filePath = this.calcFilePath(url);
        const file = Bun.file(filePath);

        try {
            const stat = await file.stat();

            return {
                addedDate: stat.ctimeMs,
                filePath
            }
        }
        catch { return undefined; }

    }
}
