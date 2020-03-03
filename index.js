const puppeteer = require('puppeteer');
const fs = require('fs');
const fsPromises = require('fs').promises;
const log4js = require('log4js');

function getArgvObj() {
  const argv = process.argv.slice(2);
  const obj = {};
  function isNotOpt(arg) {
    return !/--\w+/.test(arg)
  }
  for (let i = 0; i < argv.length; i++) {
    switch(argv[i]) {
      case '--user': obj.user = isNotOpt(argv[i + 1]) ? argv[++i] : null; break;
      case '--other': obj.other = isNotOpt(argv[i + 1]) ? argv[++i] : null;break;
    }
  }
  return obj;
}
const argvObj = getArgvObj();
if(!argvObj.user) console.error('--user arg is needed.');

log4js.configure({
  appenders: { cheese: { type: 'file', filename: 'download.log' } },
  categories: { default: { appenders: ['cheese'], level: 'debug' } }
});

const logger = log4js.getLogger('record');
logger.level = 'debug';


async function getAttributeByElem(pageHandle, elemHandle, attrName) {
  return await pageHandle.evaluate((obj, attrName) => {
    if (attrName.indexOf('&&') > 0) {
      return attrName.split('&&').map((attr) => obj.getAttribute(attr)).join('&&');
    }
    return obj.getAttribute(attrName);
  }, elemHandle, attrName);
}


(async () => {
  const browser = await puppeteer.launch({headless: false, slowMo: 250});
  const page = await browser.newPage();
  // 允许命令行直接输入QQ号 TODO TODO
  await page.goto(`https://user.qzone.qq.com/${argvObj.user}`);

  // 需要先在电脑上登录QQ
  // 等待iframe加载完毕
  const frame = await page.frames().find(f => f.name() === 'login_frame');
  await frame.waitForSelector('#qlogin_list');
  // 点击自动登录
  await frame.click('#qlogin_list>a', { delay: 3 });
  // 进入空间
  // await page.waitForNavigation({
  //   waitUntil: 'domcontentloaded'
  // });
  await page.waitFor(1000);
  // 如果需要下载其他人空间的照片需要设置其他人的QQ号
  if (argvObj.other) {
    await page.goto(`https://user.qzone.qq.com/${argvObj.other}`);
    await page.waitFor(1000);
    // 有可能出现空间因为flash插件没有直接显示的情况
    try{
      await page.click('#welcomeflash', { clickCount: 2, delay: 2 });
      await page.waitForSelector('.fs-guide-overlay', { timeout: 3000 })
      await page.click('.btn-fs-sure');
    } catch(err) {
      // 如果捕获到错误说明是正常进入空间的
      console.info(err);
    }
  }
  // 进入相册列表页面
  let photoFrame;
  async function getInAlbumsListPage() {
    try {
      await page.waitForSelector(".homepage-link");
      await page.hover("a.homepage-link")
      await page.waitForSelector('.nav-drop-down');
      await page.click('i.icon-album');
    } catch(err) {
      await page.waitForSelector("a[title='相册']");
      await page.click('a[title="相册"]');
      console.error(err);
    }
    // 进入相册页面等待加载完成
    await page.waitFor(1000);
    await page.waitForSelector('#tphoto');
    // 找到相册列表的iframe
    const photoFrame = await page.frames().find(f => {
      const identity = f.name();
      return identity === 'app_canvas_frame' || identity === 'tphoto';
    });
    // 页面滚动到底部 加载相册
    // await page.evaluate(_ => {
    //   window.scrollBy(0, window.innerHeight);
    // });
    await page.evaluate(() => {
      return new Promise((resolve, reject) => {
          let totalHeight = 0;
          let distance = 400;
          let timer = setInterval(() => {
              let scrollHeight = document.body.scrollHeight;
              window.scrollBy(0, distance);
              totalHeight += distance;
              console.log('totalHeight, ', totalHeight, ' scrollHeight ', scrollHeight)
              if(totalHeight >= scrollHeight){
                  clearInterval(timer);
                  resolve();
              }
          }, 500);
      });
    });
    

    await page.waitFor(500);
    // console.log(await page.frames());
    await photoFrame.waitForSelector('.js-album-list-ul');
    return photoFrame;
  }
  photoFrame = await getInAlbumsListPage();
  const albumList = [];
  let albumEles = await photoFrame.$$('.album-list .js-album-list-ul>li>div');
  // 获取相册列表，目前还没考虑相册列表有分页的情况... TODO TODO
  let albums = Array.from(albumEles);
  for (let i = 0; i < albums.length; i++) {
    const elementHandle = albums[i];
    const result = await getAttributeByElem(photoFrame, elementHandle, 'data-name&&data-id&&data-total');
    const [name, dataId, pictureNum] = result.split('&&');
    // const pictureNum = Number(await getAttributeByElem(photoFrame, elementHandle, 'data-total'));
    // const dataId = await getAttributeByElem(photoFrame, elementHandle, 'data-id');
    albumList.push({
      name,
      dataId,
      pictureNum: Number(pictureNum),
    })
  }

  // 相册列表在iframe里面
  const savePicturesToLocal = async (albumInfo) => {
    // todo 移除掉之前生成的文件
    const elementHandle = await photoFrame.$(`div[data-id="${albumInfo.dataId}"]`);
    await elementHandle.click();
    // await albumInfo.elementHandle.click();
    await photoFrame.waitForSelector('.list.j-pl-photolist-ul');
  
    let pictureElem = await photoFrame.$('.mod-photo-list li.j-pl-photoitem>div');
    // 点击第一个图片 弹出显示照片的框
    await pictureElem.click();
    // await page.waitFor(1000);
    for (let i = 0; i < albumInfo.pictureNum; i++) {
      try {
        await loadPicture({
          order: i,
          albumName: albumInfo.name,
          isLastOne: i === (albumInfo.pictureNum - 1)
        })
      } catch(err) {
        console.error(err);
        logger.info(`No ${i} failed.`);
      }
    }
    // 当前相册下载完毕以后，退出当前相册
    await page.$('.photo_layer_close').then((handle) => handle.click('.photo_layer_close'));
    await photoFrame.click('li[data-mod="albumlist"]');
    await photoFrame.waitForSelector('.js-album-list');
  }

  // goInAlbum
  // downloadTheAlbumPictures
  // ifFailedTryAgain
  async function goInAlbum(albumInfo) {
    // todo 移除掉之前生成的文件
    const elementHandle = await photoFrame.$(`div[data-id="${albumInfo.dataId}"]`);
    await elementHandle.click();
    // await albumInfo.elementHandle.click();
    await photoFrame.waitForSelector('.list.j-pl-photolist-ul');
    let pictureElem = await photoFrame.$('.mod-photo-list li.j-pl-photoitem>div');
    // 点击第一个图片 弹出显示照片的框
    await pictureElem.click();
  }
  async function loadPicture(picInfo) {
    // 展示大图 没有在iframe里面应该在page里面
    await page.waitForSelector('#js-image-ctn');
    const imgWrapElem = await page.$('#js-image-ctn>img');
    // 等待图片加载完成
    await page.evaluate((img) => {
      if (img.complete) return;
      return new Promise((resolve, reject) => {
        img.addEventListener('load', resolve);
        img.addEventListener('error', reject);
      })
    }, imgWrapElem);
    // 取得图片名称
    const imgName = await page.$eval('#js-photo-name', (el) => el.innerText);

    const imgUrl = await getAttributeByElem(page, imgWrapElem, 'src');
    
    const tempPage = await browser.newPage();
    const viewSource = await tempPage.goto(imgUrl);
    const headers = viewSource.headers();
    let contentType = headers['content-type'].split('/')[1];
    if (contentType === 'webp') contentType = 'jpg';
    await page.waitFor(1000);
    const albumPath = `./out/${picInfo.albumName}`;
    if(!fs.existsSync(albumPath)) {
      await fsPromises.mkdir(albumPath, { recursive: true });
    }
    
    fs.writeFile(`${albumPath}/${imgName}@${picInfo.order}.${contentType}`, await viewSource.buffer(), function(err) {
      tempPage.close();
      if(err) {
          return console.log(err);
      }
      // const info = `${albumInfo.name}第${picInfo.order+1}张图片已经被保存`;
      // loggerConsole.info(info)
      // logger.info(info);
    });
  }
  async function downloadTheAlbumPictures(albumInfo) {
    // 下载图片
    for (let i = 0; i < albumInfo.pictureNum; i++) {
      try {
        await loadPicture({
          order: i,
          albumName: albumInfo.name,
        })
        // 
        // 悬浮在元素上 然后点击下一张
        await page.hover('#js-image-ctn');
        await page.waitFor(200);
        if (i !== (albumInfo.pictureNum - 1)) await page.click('#js-btn-nextPhoto');
      } catch(err) {
        console.error(err);
        logger.info(`No ${i} failed.`);
      }
    }
  }
  async function getOutAlbum() {
    // 当前相册下载完毕以后，退出当前相册
    await page.$('.photo_layer_close').then((handle) => handle.click('.photo_layer_close'));
    await photoFrame.click('li[data-mod="albumlist"]');
    await photoFrame.waitForSelector('.js-album-list');
  }
  for (let i = 0; i < albumList.length; i++) {
    const albumInfo = albumList[i];
    if (albumInfo.pictureNum > 0) {
      try {
        logger.info(`--album ${albumInfo.name} download start.`);
        await goInAlbum(albumInfo);
        await downloadTheAlbumPictures(albumInfo);
        await getOutAlbum();
        logger.info(`--album ${albumInfo.name} download end.`);
      } catch(err) {
        console.error(err);
        logger.info(`--album ${albumInfo.name} download failed.`);
        // 如果之前一个相册下载失败，重新进入相册页面
        await getInAlbumsListPage();
      }
    }
  }

  await browser.close();
})(); 