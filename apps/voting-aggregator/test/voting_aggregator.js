const { BN, sha3 } = require('web3-utils')

const { getEventArgument, getNewProxyAddress } = require('@aragon/contract-test-helpers/events')
const { assertAmountOfEvents } = require('@aragon/contract-test-helpers/assertEvent')
const { encodeCallScript } = require('@aragon/contract-test-helpers/evmScript')
const { assertRevert } = require("./helpers/assertThrow")

const { deployDao } = require('@aragonone/voting-connectors-contract-utils/test/helpers/deploy.js')(artifacts)

const VotingAggregator = artifacts.require('VotingAggregator')

const ERC20Sample = artifacts.require('ERC20Sample')
const ERC20ViewRevertMock = artifacts.require('ERC20ViewRevertMock')
const ThinCheckpointedTokenMock = artifacts.require('ThinCheckpointedTokenMock')
const ThinStaking = artifacts.require('ThinStakingMock')
const ExecutionTarget = artifacts.require('ExecutionTarget')

const MAX_SOURCES = 20

const ERROR_ALREADY_INITIALIZED = 'INIT_ALREADY_INITIALIZED'
const ERROR_AUTH_FAILED = 'APP_AUTH_FAILED'
const ERROR_NO_POWER_SOURCE = 'VA_NO_POWER_SOURCE'
const ERROR_POWER_SOURCE_TYPE_INVALID = 'VA_POWER_SOURCE_TYPE_INVALID'
const ERROR_POWER_SOURCE_INVALID = 'VA_POWER_SOURCE_INVALID'
const ERROR_POWER_SOURCE_ALREADY_ADDED = 'VA_POWER_SOURCE_ALREADY_ADDED'
const ERROR_TOO_MANY_POWER_SOURCES = 'VA_TOO_MANY_POWER_SOURCES'
const ERROR_ZERO_WEIGHT = 'VA_ZERO_WEIGHT'
const ERROR_SAME_WEIGHT = 'VA_SAME_WEIGHT'
const ERROR_SOURCE_NOT_ENABLED = 'VA_SOURCE_NOT_ENABLED'
const ERROR_SOURCE_NOT_DISABLED = 'VA_SOURCE_NOT_DISABLED'
const ERROR_CAN_NOT_FORWARD = 'VA_CAN_NOT_FORWARD'
const ERROR_SOURCE_CALL_FAILED = 'VA_SOURCE_CALL_FAILED'
const ERROR_INVALID_CALL_OR_SELECTOR = 'VA_INVALID_CALL_OR_SELECTOR'

const bn = x => new BN(x)
const bigExp = (x, y) => bn(x).mul(bn(10).pow(bn(y)))

contract('VotingAggregator', ([_, root, unprivileged, eoa, user1, user2, someone]) => {
  const PowerSourceType = {
    Invalid: 0,
    ERC20WithCheckpointing: 1,
    ERC900: 2,
  }

  let dao, acl
  let votingAggregatorBase, votingAggregator
  let ADD_POWER_SOURCE_ROLE, MANAGE_POWER_SOURCE_ROLE, MANAGE_WEIGHTS_ROLE

  before(async () => {
    ({ dao, acl } = await deployDao(root))

    votingAggregatorBase = await VotingAggregator.new()

    ADD_POWER_SOURCE_ROLE = await votingAggregatorBase.ADD_POWER_SOURCE_ROLE()
    MANAGE_POWER_SOURCE_ROLE = await votingAggregatorBase.MANAGE_POWER_SOURCE_ROLE()
    MANAGE_WEIGHTS_ROLE = await votingAggregatorBase.MANAGE_WEIGHTS_ROLE()
  })

  beforeEach('deploy dao with voting aggregator', async () => {
    const installReceipt = await dao.newAppInstance('0x1234', votingAggregatorBase.address, '0x', false, { from: root })
    votingAggregator = await VotingAggregator.at(getNewProxyAddress(installReceipt))

    await acl.createPermission(root, votingAggregator.address, ADD_POWER_SOURCE_ROLE, root, { from: root })
    await acl.createPermission(root, votingAggregator.address, MANAGE_POWER_SOURCE_ROLE, root, { from: root })
    await acl.createPermission(root, votingAggregator.address, MANAGE_WEIGHTS_ROLE, root, { from: root })
  })

  it('has correct roles encoded', async () => {
    assert.equal(ADD_POWER_SOURCE_ROLE, sha3('ADD_POWER_SOURCE_ROLE'), 'ADD_POWER_SOURCE_ROLE not encoded correctly')
    assert.equal(MANAGE_POWER_SOURCE_ROLE, sha3('MANAGE_POWER_SOURCE_ROLE'), 'MANAGE_POWER_SOURCE_ROLE not encoded correctly')
    assert.equal(MANAGE_WEIGHTS_ROLE, sha3('MANAGE_WEIGHTS_ROLE'), 'MANAGE_WEIGHTS_ROLE not encoded correctly')
  })

  it('is a forwarder', async () => {
    assert.isTrue(await votingAggregator.isForwarder())
  })

  describe('App is not initialized yet', () => {
    const name = 'Voting Aggregator'
    const symbol = 'VA'
    const decimals = 18

    it('initializes app', async () => {
      await votingAggregator.initialize(name, symbol, decimals)
      assert.isTrue(await votingAggregator.hasInitialized(), 'not initialized')
      assert.equal(await votingAggregator.name(), name, 'name mismatch')
      assert.equal(await votingAggregator.symbol(), symbol, 'symbol mismatch')
      assert.equal((await votingAggregator.decimals()).toString(), decimals, 'decimals mismatch')
    })

    it('cannot be initialized twice', async () => {
      await votingAggregator.initialize(name, symbol, decimals)
      await assertRevert(votingAggregator.initialize(name, symbol, decimals), ERROR_ALREADY_INITIALIZED)
    })
  })

  describe('App is initialized', () => {
    let token

    beforeEach('init voting aggregator and deploy token', async () => {
      const name = 'Voting Aggregator'
      const symbol = 'VA'
      const decimals = 18

      await votingAggregator.initialize(name, symbol, decimals)
      token = await ThinCheckpointedTokenMock.new() // mints 1M e 18 tokens to sender
    })

    describe('Add power source', () => {
      it('fails to add power source if type is invalid', async () => {
        const weight = 1
        await assertRevert(
          votingAggregator.addPowerSource(token.address, PowerSourceType.Invalid, weight, { from: root }),
          ERROR_POWER_SOURCE_TYPE_INVALID
        )
      })

      it('fails to add power source if weight is zero', async () => {
        const weight = 0
        await assertRevert(
          votingAggregator.addPowerSource(token.address, PowerSourceType.ERC20WithCheckpointing, weight, { from: root }),
          ERROR_ZERO_WEIGHT
        )
      })

      it('fails to add power source if it is not contract', async () => {
        const weight = 1
        await assertRevert(
          votingAggregator.addPowerSource(eoa, PowerSourceType.ERC20WithCheckpointing, weight, { from: root }),
          ERROR_POWER_SOURCE_INVALID
        )
      })

      it('fails to add power source if the wrong type is given', async () => {
        const staking = await ThinStaking.new()

        await assertRevert(
          votingAggregator.addPowerSource(token.address, PowerSourceType.ERC900, 1, { from: root }),
          ERROR_POWER_SOURCE_INVALID
        )
        await assertRevert(
          votingAggregator.addPowerSource(staking.address, PowerSourceType.ERC20WithCheckpointing, 1, { from: root }),
          ERROR_POWER_SOURCE_INVALID
        )
      })

      it('fails to add power source if broken', async () => {
        const brokenBalanceToken = await ERC20ViewRevertMock.new()
        await brokenBalanceToken.disableBalanceOf()
        const brokenSupplyToken = await ERC20ViewRevertMock.new()
        await brokenSupplyToken.disableTotalSupply()

        await assertRevert(
          votingAggregator.addPowerSource(brokenBalanceToken.address, PowerSourceType.ERC20WithCheckpointing, 1, { from: root }),
          ERROR_POWER_SOURCE_INVALID
        )
        await assertRevert(
          votingAggregator.addPowerSource(brokenSupplyToken.address, PowerSourceType.ERC20WithCheckpointing, 1, { from: root }),
          ERROR_POWER_SOURCE_INVALID
        )
      })

      it('fails to add power source if does not have permission', async () => {
        const weight = 1
        await assertRevert(
          votingAggregator.addPowerSource(token.address, PowerSourceType.ERC20WithCheckpointing, weight, { from: unprivileged }),
          ERROR_AUTH_FAILED
        )
      })

      it('adds power source', async () => {
        const weight = 1
        const type = PowerSourceType.ERC20WithCheckpointing
        const numPowerSourcesAtStart = await votingAggregator.getPowerSourcesLength()

        const receipt = await votingAggregator.addPowerSource(token.address, type, weight, { from: root })
        assertAmountOfEvents(receipt, 'AddPowerSource')
        assert.equal(
          (numPowerSourcesAtStart.add(bn(1))).toString(),
          (await votingAggregator.getPowerSourcesLength()).toString(),
          'power sources length not incremented'
        )

        const powerSourceAddress = await votingAggregator.powerSources(0)
        assert.equal(powerSourceAddress, token.address, 'source address mismatch')

        const powerSource = await votingAggregator.getPowerSourceDetails(token.address)
        assert.equal(powerSource[0], type, 'source type mismatch')
        assert.isTrue(powerSource[1], 'source enabled mismatch')
        assert.equal(powerSource[2].toString(), weight, 'weight mismatch')
      })

      it('fails to add power source if it has already been added', async () => {
        await votingAggregator.addPowerSource(token.address, PowerSourceType.ERC20WithCheckpointing, 1, { from: root })
        await assertRevert(
          votingAggregator.addPowerSource(token.address, PowerSourceType.ERC20WithCheckpointing, 1, { from: root }),
          ERROR_POWER_SOURCE_ALREADY_ADDED
        )
      })

      it('fails to add if too many power sources', async () => {
        // Add maximum number of sources to voting aggregator
        const tokens = []
        for (let ii = 0; ii < MAX_SOURCES; ++ii) {
          tokens[ii] = await ThinCheckpointedTokenMock.new()
        }
        for (const token of tokens) {
          await votingAggregator.addPowerSource(token.address, PowerSourceType.ERC20WithCheckpointing, 1, { from: root })
        }
        assert.equal(tokens.length, MAX_SOURCES, 'added number of tokens should match max sources')

        // Adding one more should fail
        const oneTooMany = await ThinCheckpointedTokenMock.new()
        await assertRevert(
          votingAggregator.addPowerSource(oneTooMany.address, PowerSourceType.ERC20WithCheckpointing, 1, { from: root }),
          ERROR_TOO_MANY_POWER_SOURCES
        )
      })
    })

    describe('Change source weight', () => {
      const weight = 1
      let sourceAddr

      before(() => {
        sourceAddr = token.address
      })

      beforeEach('add power source', async () => {
        const type = PowerSourceType.ERC20WithCheckpointing
        await votingAggregator.addPowerSource(sourceAddr, type, weight, { from: root })
      })

      it('fails to change power source weight if does not have permission', async () => {
        await assertRevert(votingAggregator.changeSourceWeight(sourceAddr, weight, { from: unprivileged }), ERROR_AUTH_FAILED)
      })

      it('fails to change power source weight if source does not exist', async () => {
        await assertRevert(votingAggregator.changeSourceWeight(someone, weight, { from: root }), ERROR_NO_POWER_SOURCE)
      })

      it('fails to change power source weight if weight is zero', async () => {
        await assertRevert(votingAggregator.changeSourceWeight(sourceAddr, 0, { from: root }), ERROR_ZERO_WEIGHT)
      })

      it('fails to change power source weight if weight is the same', async () => {
        await assertRevert(votingAggregator.changeSourceWeight(sourceAddr, weight, { from: root }), ERROR_SAME_WEIGHT)
      })

      it('changes power source weight', async () => {
        const newWeight = weight + 1

        const receipt = await votingAggregator.changeSourceWeight(sourceAddr, newWeight, { from: root })
        assertAmountOfEvents(receipt, 'ChangePowerSourceWeight')

        const powerSource = await votingAggregator.getPowerSourceDetails(sourceAddr)
        assert.equal(powerSource[2].toString(), newWeight, 'weight should have changed')
      })
    })

    describe('Disable source', () => {
      let sourceAddr

      before(() => {
        sourceAddr = token.address
      })

      beforeEach('add power source', async () => {
        const type = PowerSourceType.ERC20WithCheckpointing
        const weight = 1
        await votingAggregator.addPowerSource(sourceAddr, type, weight, { from: root })
      })

      it('fails to disable power source if does not have permission', async () => {
        await assertRevert(votingAggregator.disableSource(sourceAddr, { from: unprivileged }), ERROR_AUTH_FAILED)
      })

      it('fails to disable power source if source does not exist', async () => {
        await assertRevert(votingAggregator.disableSource(someone, { from: root }), ERROR_NO_POWER_SOURCE)
      })

      it('fails to disable power source if source not enabled', async () => {
        await votingAggregator.disableSource(sourceAddr, { from: root })

        await assertRevert(votingAggregator.disableSource(sourceAddr, { from: root }), ERROR_SOURCE_NOT_ENABLED)
      })

      it('disables power source', async () => {
        const receipt = await votingAggregator.disableSource(sourceAddr, { from: root })
        assertAmountOfEvents(receipt, 'DisablePowerSource')

        const powerSource = await votingAggregator.getPowerSourceDetails(sourceAddr)
        assert.isFalse(powerSource[1], 'source should be disabled')
      })
    })

    describe('Enable source', () => {
      let sourceAddr

      before(() => {
        sourceAddr = token.address
      })

      beforeEach('add and disable power source', async () => {
        const type = PowerSourceType.ERC20WithCheckpointing
        const weight = 1
        await votingAggregator.addPowerSource(sourceAddr, type, weight, { from: root })

        await votingAggregator.disableSource(sourceAddr, { from: root })
      })

      it('fails to enable power source if does not have permission', async () => {
        await assertRevert(votingAggregator.enableSource(sourceAddr, { from: unprivileged }), ERROR_AUTH_FAILED)
      })

      it('fails to enable power source if source does not exist', async () => {
        await assertRevert(votingAggregator.enableSource(someone, { from: root }), ERROR_NO_POWER_SOURCE)
      })

      it('fails to enable power source if source not disabled', async () => {
        await votingAggregator.enableSource(sourceAddr, { from: root })

        await assertRevert(votingAggregator.enableSource(sourceAddr, { from: root }), ERROR_SOURCE_NOT_DISABLED)
      })

      it('enables power source', async () => {
        const receipt = await votingAggregator.enableSource(sourceAddr, { from: root })
        assertAmountOfEvents(receipt, 'EnablePowerSource')

        const powerSource = await votingAggregator.getPowerSourceDetails(sourceAddr)
        assert.isTrue(powerSource[1], 'source should be enabled')
      })
    })

    describe('Aggregation', () => {
      let staking

      const users = [
        { address: user1, amount: bigExp(1, 18) },
        { address: user2, amount: bigExp(2, 18) }
      ]
      const checkpoints = [1, 2, 3].map(c => bn(c))
      const lastCheckpoint = checkpoints[checkpoints.length - 1]

      const addBalances = async (blockNumber) => {
        Promise.all(users.map(
          user => checkpoints.map(
            checkpoint => [
              token.addBalanceAt(user.address, blockNumber.add(checkpoint), user.amount.mul(checkpoint)),
              staking.stakeForAt(user.address, blockNumber.add(checkpoint), user.amount.mul(checkpoint).mul(bn(2)))
            ]
          )
        ).reduce((acc, val) => acc.concat(val), []))
      }

      beforeEach('deploy staking, add sources', async () => {
        // deploy staking
        staking = await ThinStaking.new()

        // add sources
        const tokenWeight = 1
        const stakingWeight = 3
        await votingAggregator.addPowerSource(token.address, PowerSourceType.ERC20WithCheckpointing, tokenWeight, { from: root })
        await votingAggregator.addPowerSource(staking.address, PowerSourceType.ERC900, stakingWeight, { from: root })

        assert.equal(
          (await votingAggregator.getPowerSourcesLength()).toString(),
          '2',
          'number of added power sources not correct'
        )

        const sourceAddr1 = await votingAggregator.powerSources(0)
        const sourceAddr2 = await votingAggregator.powerSources(1)
        assert.equal(sourceAddr1, token.address, 'first source should be token')
        assert.equal(sourceAddr2, staking.address, 'second source should be token')
      })

      context('When all sources are enabled', () => {
        let blockNumber

        beforeEach('add balances', async () => {
          blockNumber = bn(await getBlockNumber(ethers.provider))
          await addBalances(blockNumber)
        })

        it('user aggregations match', async () => {
          for (const user of users) {
            for (const checkpointOffset of checkpoints) {
              const checkpoint = blockNumber.add(checkpointOffset)
              assert.equal(
                (await votingAggregator.balanceOfAt(user.address, checkpoint)).toString(),
                user.amount.mul(checkpointOffset).mul(bn(7)).toString(),
                `balance doesn't match for user ${user.address} and checkpoint ${checkpoint}`
              )
            }

            assert.equal(
              (await votingAggregator.balanceOf(user.address)).toString(),
              (await votingAggregator.balanceOfAt(user.address, lastCheckpoint)).toString(),
              "balance doesn't match between balanceOf() and balanceOfAt() for latest checkpoint"
            )
          }
        })

        it('total aggregations match', async () => {
          for (const checkpointOffset of checkpoints) {
            const checkpoint = blockNumber.add(checkpointOffset)
            assert.equal(
              (await votingAggregator.totalSupplyAt(checkpoint)).toString(),
              users.reduce(
                (acc, user) => acc.add(user.amount.mul(checkpointOffset).mul(bn(7))),
                bn(0)
              ).toString(),
              `total supply doesn't match at checkpoint ${checkpoint}`
            )

            assert.equal(
              (await votingAggregator.totalSupply()).toString(),
              (await votingAggregator.totalSupplyAt(lastCheckpoint)).toString(),
              "totalSupply doesn't match between totalSupply() and totalSupplyOfAt() for latest checkpoint"
            )
          }
        })
      })

      context('When some sources are disabled', () => {
        let blockNumber

        // Make sure to disable source before adding balances for checkpointing
        beforeEach('disable token source', async () => {
          await votingAggregator.disableSource(staking.address, { from: root })
        })

        beforeEach('add balances', async () => {
          blockNumber = bn(await getBlockNumber())

          await addBalances(blockNumber)
        })

        it('user aggregations match', async () => {
          for (const user of users) {
            for (const checkpointOffset of checkpoints) {
              const checkpoint = blockNumber.add(checkpointOffset)
              assert.equal(
                (await votingAggregator.balanceOfAt(user.address, checkpoint)).toString(),
                user.amount.mul(checkpointOffset).toString(),
                `balance doesn't match for user ${user.address} and checkpoint ${checkpoint}`
              )
            }
          }
        })

        it('total aggregations match', async () => {
          for (const checkpointOffset of checkpoints) {
            const checkpoint = blockNumber.add(checkpointOffset)
            assert.equal(
              (await votingAggregator.totalSupplyAt(checkpoint)).toString(),
              users.reduce(
                (acc, user) => acc.add(user.amount.mul(checkpointOffset)),
                bn(0)
              ).toString(),
              `total supply doesn't match at checkpoint ${checkpoint}`
            )
          }
        })
      })

      context('When some sources are broken', () => {
        let brokenSource

        beforeEach('add broken source', async () => {
          const brokenBalanceToken = await ERC20ViewRevertMock.new()
          brokenSource = brokenBalanceToken.address
          await votingAggregator.addPowerSource(brokenBalanceToken.address, PowerSourceType.ERC20WithCheckpointing, 1, { from: root })

          // Break token
          await brokenBalanceToken.disableBalanceOf()
        })

        it('fails to aggregate if source is broken after being added', async () => {
          await assertRevert(votingAggregator.balanceOf(user1), ERROR_SOURCE_CALL_FAILED)
        })

        it('can aggregate after broken source is disabled', async () => {
          await votingAggregator.disableSource(brokenSource, { from: root })

          assert.doesNotThrow(async () => await votingAggregator.balanceOf(user1))
        })
      })
    })

    describe('Forwarding', () => {
      let sourceAddr
      let executionTarget

      before(async () => {
        const sampleToken = await ERC20Sample.new()
        sourceAddr = sampleToken.address
        await sampleToken.transfer(user1, bigExp(1, 18))
        await sampleToken.transfer(user2, bigExp(1, 18))

        executionTarget = await ExecutionTarget.new()
      })

      beforeEach('add power source', async () => {
        const type = PowerSourceType.ERC20WithCheckpointing
        const weight = 1
        await votingAggregator.addPowerSource(sourceAddr, type, weight, { from: root })
      })

      it('allows accounts with voting power to forward', async () => {
        assert.isTrue(await votingAggregator.canForward(user1, '0x'))
      })

      it('allows accounts with voting power to successfully execute forward', async () => {
        const action = { to: executionTarget.address, calldata: executionTarget.contract.methods.execute().encodeABI() }
        const script = encodeCallScript([action])

        await votingAggregator.forward(script, { from: user1 })
        assert.equal((await executionTarget.counter()).toString(), 1, 'should have received execution call')
      })

      it('fails to forward if account does not have voting power', async () => {
        const action = { to: executionTarget.address, calldata: executionTarget.contract.methods.execute().encodeABI() }
        const script = encodeCallScript([action])

        assert.isFalse(
          await votingAggregator.canForward(someone, '0x'),
          'should not say someone without voting power can forward'
        )
        await assertRevert(votingAggregator.forward(script, { from: someone }), ERROR_CAN_NOT_FORWARD)
      })
    })
  })
})
