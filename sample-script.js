const username = 'bill'
const password = 'ted'

if (accounts.indexOf(username) === -1) {
  createAccount(username, password, doOtherStuff)
} else {
  doOtherStuff()
}

function doOtherStuff () {
}
