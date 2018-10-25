module.exports = function (router, done) {

  router.post('/captcha', function (req, res) {
    res.json({
      success: true
    });
  });

  done();
};
