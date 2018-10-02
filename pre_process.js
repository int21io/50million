const path = require("path");
const fs = require("fs");

const INPUT_FILE = "data/MoonlightSonata.raw";
const DESCRIPTOR_FILE = "data/descriptor.json";

const WINDOW_SIZE = 16;
const MAX_ELEMENTS = 4000;

const MIN_VALUE = -128;
const MAX_VALUE = 127;

// Check to see how many elements are in the input file.
const nElements = fs.statSync(INPUT_FILE).size;

// Work out how many scale levels will be required for our needs.
const nLodLevels = Math.ceil(Math.log(nElements/MAX_ELEMENTS)/Math.log(WINDOW_SIZE));

class LodFile {
    constructor(level) {
        this.level = level;
        this.fileName = this.make_filename(INPUT_FILE, level);
        this.nElements = 0;

        this.fout = fs.openSync(this.fileName, "w");
        this.elementsPerLevel = Math.pow(WINDOW_SIZE, level);
        this.minMaxBuffer = Buffer.alloc(2);
        this.reset();
    }

    make_filename(baseFile, level) {
        const dir = path.dirname(baseFile);
        const ext = path.extname(baseFile);
        const fname = path.basename(baseFile, ext);
        const relativePath = path.join(dir, `${fname}_${level}${ext}`);
        const cleanPath = relativePath.replace(new RegExp('\\' + path.sep, 'g'), '/');
        return cleanPath;
    }

    close() {
        fs.closeSync(this.fout);
    }

    reset() {
        this.processed = 0;
        this.min = MAX_VALUE;
        this.max = MIN_VALUE;
    }

    process(value) {
        if (value < this.min) {
            this.min = value;
        }

        if (value > this.max) {
            this.max = value;
        }

        this.processed++;
        if (this.processed === this.elementsPerLevel) {

            this.minMaxBuffer.writeInt8(this.min, 0);
            this.minMaxBuffer.writeInt8(this.max, 1);
            fs.writeSync(this.fout, this.minMaxBuffer);
            this.nElements++;

            this.reset();
        }
    }
}
 
console.log(`Pre-processing ${nElements} elements with ${nLodLevels} LOD levels`);

const lodFiles = [];
for(let level=1; level <= nLodLevels; level++) {
    lodFiles.push(new LodFile(level));
}

const fin = fs.openSync(INPUT_FILE, "r");
let buf = Buffer.alloc(1024);
let bytesRead = fs.readSync(fin, buf, 0, 1024);
while(bytesRead > 0) {

    for(const lodFile of lodFiles) {
        for(let j=0; j < bytesRead; j++) {
            lodFile.process(buf.readInt8(j));
        }
    }

    bytesRead = fs.readSync(fin, buf, 0, 1024);
}

fs.closeSync(fin);

const descriptor = {
    fileName: INPUT_FILE,
    nElements: nElements,
    fileSize: nElements,
    maxElements: MAX_ELEMENTS,
    windowSize: WINDOW_SIZE,
    lodFiles: []
};

for(const lodFile of lodFiles) {
    lodFile.close();
    descriptor.lodFiles.push({
            fileName: lodFile.fileName,
            fileSize: fs.statSync(lodFile.fileName).size,
            level: lodFile.level,
            nElements: lodFile.nElements,
    });
}

fs.writeFileSync(DESCRIPTOR_FILE, JSON.stringify(descriptor,null, 4));

console.log("LOD files written");
