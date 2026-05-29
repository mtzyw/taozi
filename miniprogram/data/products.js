const generatedImages = require('../utils/generated-images');

const fallbackImage = (generatedImages[0] && generatedImages[0].src) || '/assets/images/generated/test-showcase.png';
const imageByName = (name) => {
  const matched = generatedImages.find((item) => item.name === name);
  return (matched && matched.src) || fallbackImage;
};
const earlySummerImage = imageByName('peach-early-summer-box');
const familyBagImage = imageByName('peach-family-bag');
const premiumBoxImage = imageByName('peach-premium-box');

module.exports = [
  {
    id: 'peach-early-summer-box',
    name: '早夏水蜜桃预售礼盒',
    subtitle: '精选大果，甜香多汁，适合送礼和家庭分享',
    coverImage: earlySummerImage,
    images: [earlySummerImage],
    packageTypes: ['box', 'bag'],
    price: 12800,
    salePrice: 10800,
    skus: [
      {
        id: 'early-box-6jin',
        packageType: 'box',
        label: '盒装',
        name: '6 斤礼盒装',
        weightText: '约 6 斤',
        price: 12800,
        salePrice: 10800,
        stock: 100,
        deliveryMethods: ['pickup', 'express']
      },
      {
        id: 'early-bag-4jin',
        packageType: 'bag',
        label: '袋装',
        name: '4 斤家庭袋装',
        weightText: '约 4 斤',
        price: 9800,
        salePrice: 8800,
        stock: 80,
        deliveryMethods: ['pickup']
      }
    ],
    stock: 180,
    status: 'on_sale',
    deliveryMethods: ['pickup', 'express'],
    presaleNote: '预售商品，预计 6 月下旬按成熟批次发货/自提。',
    listedAt: '2026-05-13T05:52:08.059Z',
    tags: ['最新上架', '预售', '白名单8折']
  },
  {
    id: 'peach-family-bag',
    name: '家庭尝鲜袋装桃',
    subtitle: '袋装实惠款，适合家庭日常尝鲜',
    coverImage: familyBagImage,
    images: [familyBagImage],
    packageTypes: ['bag'],
    price: 8800,
    salePrice: 7600,
    skus: [
      {
        id: 'family-bag-5jin',
        packageType: 'bag',
        label: '袋装',
        name: '5 斤尝鲜袋装',
        weightText: '约 5 斤',
        price: 8800,
        salePrice: 7600,
        stock: 60,
        deliveryMethods: ['pickup']
      }
    ],
    stock: 60,
    status: 'on_sale',
    deliveryMethods: ['pickup'],
    presaleNote: '袋装商品优先自提，按到货批次通知取货。',
    listedAt: '2026-05-12T10:00:00.000Z',
    tags: ['自提优先', '袋装']
  },
  {
    id: 'peach-premium-box',
    name: '精品大果桃礼盒',
    subtitle: '大果礼盒装，适合企业团购和节礼',
    coverImage: premiumBoxImage,
    images: [premiumBoxImage],
    packageTypes: ['box'],
    price: 16800,
    salePrice: 14800,
    skus: [
      {
        id: 'premium-box-8jin',
        packageType: 'box',
        label: '盒装',
        name: '8 斤精品礼盒',
        weightText: '约 8 斤',
        price: 16800,
        salePrice: 14800,
        stock: 0,
        deliveryMethods: ['pickup', 'express']
      }
    ],
    stock: 0,
    status: 'on_sale',
    deliveryMethods: ['pickup', 'express'],
    presaleNote: '当前批次已售罄，补货后自动恢复展示。',
    listedAt: '2026-05-10T10:00:00.000Z',
    tags: ['礼盒', '售罄示例']
  }
];
