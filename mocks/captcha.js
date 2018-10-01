module.exports = function (router) {

  router.post('/captcha', function (req, res) {
    res.json({
      success: true
    });
  });
};
