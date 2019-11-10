const puppeteer = require('puppeteer');
const fs = require('fs');
const fsPromises = require('fs').promises;
const log4js = require('log4js');


log4js.configure({
  appenders: { cheese: { type: 'file', filename: 'cheese.log' } },
  categories: { default: { appenders: ['cheese'], level: 'debug' } }
});

const logger = log4js.getLogger('cheese');
const loggerConsole = log4js.getLogger();
loggerConsole.level = 'debug'


async function getAttributeByElem(pageHandle, elemHandle, attrName) {
  return await pageHandle.evaluate((obj, attrName) => {
    if (attrName.indexOf('&&') > 0) {
      return attrName.split('&&').map((attr) => obj.getAttribute(attr)).join('&&');
    }
    return obj.getAttribute(attrName);
  }, elemHandle, attrName);
}


(async () => {
  const browser = await puppeteer.launch({headless: true, slowMo: 250});
  const page = await browser.newPage();
  // 允许命令行直接输入QQ号 TODO TODO
  await page.goto('https://user.qzone.qq.com/1475099525');
  // 需要先在电脑上登录QQ
  // 等待iframe加载完毕
  const frame = await page.frames().find(f => f.name() === 'login_frame');
  await frame.waitForSelector('#qlogin_list');
  // 点击自动登录
  await frame.click('#qlogin_list>a', { delay: 3 });
  // 进入空间
  await page.waitForNavigation({
    waitUntil: 'domcontentloaded'
  });
  await page.waitForSelector("a[title='相册']");
  await page.click('a[title="相册"]');
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
  // console.log(photoFrame);
  const albumList = [];
  let albumEles = await photoFrame.$$('.album-list .js-album-list-ul>li>div');
  // 获取相册列表，目前还没考虑相册翻页的情况... TODO TODO
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

    // let pictureElems = await photoFrame.$$('.mod-photo-list li.j-pl-photoitem>div');
    // // console.log(pictureElems);
    // let pictures = Array.from(pictureElems);
    // const pictureList = [];
    // for (let j = 0; j < pictures.length; j++) {
    //   const picElemHandle = pictures[j];
    //   const titleSpanElem = await picElemHandle.$('.item-tit>span');
    //   const name = await getAttributeByElem(photoFrame, titleSpanElem, 'title');
    //   pictureList.push({
    //     name,
    //     albumName: albumInfo.name,
    //     elementHandle: picElemHandle,
    //     order: j,
    //     isLastOne: j === (pictures.length - 1)
    //   })
    // }
    
    // 下载图片
    const loadPicture = async (picInfo) => {
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
        const info = `${albumInfo.name}第${picInfo.order+1}张图片已经被保存`;
        loggerConsole.info(info)
        logger.info(info);
      });
      // 悬浮在元素上 然后点击下一张
      await page.hover('#js-image-ctn');
      await page.waitFor(200);
      if (!picInfo.isLastOne) await page.click('#js-btn-nextPhoto');
    }
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
        logger.trace(`相册${albumInfo.name}第${i+1}张图片下载失败`);
      }
    }
    // 当前相册下载完毕以后，退出当前相册
    await page.$('.photo_layer_close').then((handle) => handle.click('.photo_layer_close'));
    await photoFrame.click('li[data-mod="albumlist"]');
    await photoFrame.waitForSelector('.js-album-list');
  }
  for (let i = 0; i < albumList.length; i++) {
    const albumInfo = albumList[i];
    if (albumInfo.pictureNum > 0) {
      try {
        await savePicturesToLocal(albumInfo);
      } catch(err) {
        console.error(err);
        logger.trace(`相册${albumInfo.name}下载失败`);
        // 当前相册下载完毕以后，退出当前相册
        try {
          await page.$('.photo_layer_close').then((handle) => handle.click('.photo_layer_close'));
        } catch(err) {
          console.error(err);
        }
        await photoFrame.click('li[data-mod="albumlist"]');
        await photoFrame.waitForSelector('.js-album-list');
      }
    }
  }

  await browser.close();
})(); 