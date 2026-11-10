## Strategy `2TmcmquxnCB8AHoLmLJFYxZnVQdm9pREMEsmHqByQq7G`

Version sha256 `2a05af131304b169d006350a8e4f42113dad86cb25934d17e676193d69c5b784`, deployed in slot 520610391, upgrade authority `ENj4ENQWKzMfFdsbWi96vMNaBPRkQDoRDaFzsgi2PbD6`.
Instructions beyond Pipeline's own: ClaimFees, ClosePack, OpenDraw, OpenPack.
7 markets. `pipeline-check` result: 6 fail, 1 pass.

- 6 market(s) cannot read state: AccountDidNotDeserialize (3003): 3fjboEpg, 5cNpJXz2, 6PAghGiJ, EChtAxyR, Feqj8Ksw, GvGQhcrT
- 1 market(s) trades: CmDa9bCs

| Market | Pair | pipeline-check | Round trip by size | Hold then sell | Arrive later | Clock at launch | Wallets | Transferred | Queue of 5 | Quotes = swaps | Direct call | Token authorities acting |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `CmDa9bCs` | 0>1>0 | pass (13p 0w 0f 1s) | 2000: 98.5037%; 200000: 98.5092%; 2000000: 98.5094%; 20000000: 98.5102%; 100000000: 98.5136% | 98.5094% (9 runs) | 98.5094% (8 runs) | 98.5094% (5 runs) | fresh 98.5094% (5 runs); market creator: 98.5094% | 98.5094% | 5 of 5 sold, 98.5096% back in all | 71/71 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 90.6297% of the other vault |

## Strategy `4LHmX6x7xgB2eNeuRsuF3U3huhFoyfYeddRLzsBwzvPc`

Version sha256 `0b3177fe0ade852a64ee35c404c54df363f97d17875518f1c2bc02f298c67cfa`, deployed in slot 520604844, upgrade authority `ENj4ENQWKzMfFdsbWi96vMNaBPRkQDoRDaFzsgi2PbD6`.
Instructions beyond Pipeline's own: BurnToClose, ClaimFees, Deploy.
2 markets. `pipeline-check` result: 2 pass.

- 2 market(s) trades: 2aoXNhjC, 4dQ9LNDq

| Market | Pair | pipeline-check | Round trip by size | Hold then sell | Arrive later | Clock at launch | Wallets | Transferred | Queue of 5 | Quotes = swaps | Direct call | Token authorities acting |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `2aoXNhjC` | 0>1>0 | pass (13p 0w 0f 1s) | 997: 97.8%; 99700: 97.913%; 997000: 97.9161%; 9970000: 97.9163%; 49850000: 97.9167% | 97.9161% (9 runs) | 97.9161% (8 runs) | 97.9161% (5 runs) | fresh 97.9161% (5 runs); market creator: 97.9161% | 97.9161% | 5 of 5 sold, 97.9161% back in all | 71/71 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 49.4174% of the other vault |
| `4dQ9LNDq` | 0>1>0 | pass (13p 0w 0f 1s) | 997: 97.8%; 99700: 97.913%; 997000: 97.9161%; 9970000: 97.9163%; 49850000: 97.9167% | 97.9161% (9 runs) | 97.9161% (8 runs) | 97.9161% (5 runs) | fresh 97.9161% (5 runs); market creator: 97.9161% | 97.9161% | 5 of 5 sold, 97.9161% back in all | 71/71 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 49.4174% of the other vault |

## Strategy `4ajWF6Y3wsxXUbvvaEu7ZcA2RosB1YfaXcqot8kguwJD`

Version sha256 `534a2494c0e3e421096afd8bc0b45dfeca7fc94446899f9c19acaf767c9c5d63`, deployed in slot 520151758, upgrade authority `2yJJsmhvs2SBsKVtiKCG4wBJNoTH67aRNMhSwkupvUHZ`.
Instructions beyond Pipeline's own: RebalanceWall, SeedPool, SettleRetired, SweepFees.
8 markets. `pipeline-check` result: 6 fail, 2 pass.

- 6 market(s) cannot read state: AccountDidNotDeserialize (3003): 2g5T3r4L, 4PswGH2h, 52AgAbsZ, DR2MLH5W, EWotvPLv, judQJaXD
- 2 market(s) trades: 8Vr412RM, eeuwZDiV

| Market | Pair | pipeline-check | Round trip by size | Hold then sell | Arrive later | Clock at launch | Wallets | Transferred | Queue of 5 | Quotes = swaps | Direct call | Token authorities acting |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `8Vr412RM` | 1>0>1 | pass (13p 0w 0f 1s) | 10000: 98.2045%; 1000000: 98.2174%; 10000000: 98.2532%; 100000000: 98.4976%; 1000000000: 98.9468%; 10000000000: 99.0844% | 98.2532% (9 runs) | 98.2532% (8 runs) | 98.2532% (6 runs) | fresh 98.2532% (5 runs); market creator: 98.2532% | 98.2532% | 5 of 5 sold, 98.3841% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | none found |
| `eeuwZDiV` | 1>0>1 | pass (13p 0w 0f 1s) | 10000: 98.2045%; 1000000: 98.2391%; 10000000: 98.4184%; 100000000: 98.8804%; 1000000000: 99.0743%; 10000000000: 99.1% | 98.4184% (9 runs) | 98.4184% (8 runs) | 98.4184% (6 runs) | fresh 98.4184% (5 runs); market creator: 98.4184% | 98.4184% | 5 of 5 sold, 98.7657% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | none found |

## Strategy `4scUVyL9JbLjvkppBk8PYNGRPMCQfp7ppdBFkthDYPLA`

Version sha256 `e1c476b98a194c4e2b09a72ad1b93d9707f8daa82fc6d12db20e07ab1268e30d`, deployed in slot 520561409, upgrade authority `ENj4ENQWKzMfFdsbWi96vMNaBPRkQDoRDaFzsgi2PbD6`.
Instructions beyond Pipeline's own: ClaimFees.
3 markets. `pipeline-check` result: 2 fail, 1 pass.

- 2 market(s) cannot read state: AccountDidNotDeserialize (3003): CpA1g1zd, FVhBg763
- 1 market(s) trades: DAWRtFaU

| Market | Pair | pipeline-check | Round trip by size | Hold then sell | Arrive later | Clock at launch | Wallets | Transferred | Queue of 5 | Quotes = swaps | Direct call | Token authorities acting |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `DAWRtFaU` | 0>1>0 | pass (13p 0w 0f 1s) | 99: 96.0%; 9950: 98.4962%; 99500: 98.5083%; 995000: 98.5093%; 4975000: 98.5094% | 98.5083% (9 runs) | 98.5083% (8 runs) | 98.5083% (5 runs) | fresh 98.5083% (5 runs); market creator: 98.5083% | 98.5083% | 5 of 5 sold, 98.5081% back in all | 71/71 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 8.9799% of the other vault |

## Strategy `9mAV3pMKXx67poy98jHizWM6TEeKJ5g48ZeD83xFa1UF`

Version sha256 `062e4c0bf1c8fa0151f2d49599ae577b3fc923affb466f39a05a5fb23e8b1cfa`, deployed in slot 520136342, upgrade authority `FWbhWcufRWM3CsVb6MixpwtNXWMYQbhQo3uWEfg4vrKq`.
Instructions beyond Pipeline's own: Buy, Buyback, CreateMarket, DeepenQuote, DeepenToken, InitializeFactory, PublishManifest, Sell, SetMetadata, SplitFees.
4 markets. `pipeline-check` result: 2 pass, 2 warn.

- 4 market(s) trades: 2u5ep2aL, 4FXwjRnD, ChLMN5ju, FUJgo86z

| Market | Pair | pipeline-check | Round trip by size | Hold then sell | Arrive later | Clock at launch | Wallets | Transferred | Queue of 5 | Quotes = swaps | Direct call | Token authorities acting |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `2u5ep2aL` | 0>1>0 | pass (13p 0w 0f 1s) | 10000: 48.7481%; 1000000: 48.7614%; 10000000: 48.7668%; 100000000: 48.8007%; 1000000000: 49.1983%; 10000000000: 52.5618% | 48.7668% (9 runs) | 48.7668% (8 runs) | 48.7668% (6 runs) | fresh 48.7668% (5 runs); market creator: 48.7668%; mint authority of mint 1: n/a | 48.7668% | 5 of 5 sold, 48.7866% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 1: not run (the authority is a program's address, not a wallet) |
| `4FXwjRnD` | 0>1>0 | pass (13p 0w 0f 1s) | 10000: 48.7581%; 1000000: 49.2089%; 10000000: 49.4151%; 100000000: 49.4467%; 1000000000: 49.45%; 10000000000: 49.5142% | 49.4151% (9 runs) | 49.4151% (8 runs) | 49.4151% (6 runs) | fresh 49.4151% (5 runs); market creator: 49.4151%; mint authority of mint 1: n/a | 49.4151% | 5 of 5 sold, 49.703% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 1: not run (the authority is a program's address, not a wallet) |
| `ChLMN5ju` | 0>1>0 | warn (12p 1w 0f 1s) | 10000: 48.7481%; 1000000: 48.868%; 10000000: 49.2708%; 100000000: 49.5772%; 1000000000: 49.6337%; 10000000000: 50.8237% | 49.2708% (9 runs) | 49.2708% (8 runs) | 49.2708% (6 runs) | fresh 49.2708% (5 runs); market creator: 49.2708%; mint authority of mint 1: n/a | 49.2708% | 5 of 5 sold, 49.6396% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 1: not run (the authority is a program's address, not a wallet) |
| `FUJgo86z` | 0>1>0 | warn (12p 1w 0f 1s) | 10000: 48.7681%; 1000000: 49.2682%; 10000000: 49.4261%; 100000000: 49.4474%; 1000000000: 49.5659%; 10000000000: 52.1609% | 49.4261% (9 runs) | 49.4261% (8 runs) | 49.4261% (6 runs) | fresh 49.4261% (5 runs); market creator: 49.4261%; mint authority of mint 1: n/a | 49.4261% | 5 of 5 sold, 49.7107% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 1: not run (the authority is a program's address, not a wallet) |

## Strategy `ETrmUegraeyB7B6fXBfANmV7w9aEwM3wUEUzFHqo5zAb`

Version sha256 `74fca48eb995bb0ab472f642c0c88ac9125168797effe3c880bc6ce4309c3923`, deployed in slot 520151724, upgrade authority `2yJJsmhvs2SBsKVtiKCG4wBJNoTH67aRNMhSwkupvUHZ`.
Instructions beyond Pipeline's own: ClaimAllocation, ClaimCreatorFees, ClaimLeftover, FundCurve, Graduate, SetFeeRecipient.
12 markets. `pipeline-check` result: 12 warn.

- 9 market(s) strategy refused: WrongStatus (6004): 24UgWpWc, 3Hutxg8q, 3YxLDwTw, 7NWjaeqo, 7d6ddfXT, 9Mg9WPbk, D8wkjAWK, DT1UKocS, FqUSKA2J
- 3 market(s) trades: 6efYzb4y, 6tbu9cVF, EFpSeL9z

| Market | Pair | pipeline-check | Round trip by size | Hold then sell | Arrive later | Clock at launch | Wallets | Transferred | Queue of 5 | Quotes = swaps | Direct call | Token authorities acting |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `6efYzb4y` | 1>0>1 | warn (12p 2w 0f 0s) | 10000: 98.5037%; 1000000: 98.5117%; 10000000: 98.5316%; 100000000: 98.632%; 1000000000: STUCK (strategy refused: WrongStatus (6004)); 10000000000: STUCK (strategy refused: WrongStatus (6004)) | 98.5316% (9 runs) | 98.5316% (8 runs) | 98.5316% (6 runs) | fresh 98.5316% (5 runs); market creator: 98.5316% | 98.5316% | 5 of 5 sold, 98.591% back in all | 72/72 | refused (NotPipeline); refused (AccountNotSigner) | none found |
| `6tbu9cVF` | 1>0>1 | warn (12p 2w 0f 0s) | 10000: 97.5162%; 1000000: 97.5241%; 10000000: 97.5437%; 100000000: 97.6429%; 1000000000: STUCK (strategy refused: WrongStatus (6004)); 10000000000: STUCK (strategy refused: WrongStatus (6004)) | 97.5437% (9 runs) | 97.5437% (8 runs) | 97.5437% (6 runs) | fresh 97.5437% (5 runs); market creator: 97.5437% | 97.5437% | 5 of 5 sold, 97.6024% back in all | 72/72 | refused (NotPipeline); refused (AccountNotSigner) | none found |
| `EFpSeL9z` | 1>0>1 | warn (12p 2w 0f 0s) | 10000: 98.5037%; 1000000: 98.5117%; 10000000: 98.5316%; 100000000: 98.632%; 1000000000: STUCK (strategy refused: WrongStatus (6004)); 10000000000: STUCK (strategy refused: WrongStatus (6004)) | 98.5316% (9 runs) | 98.5316% (8 runs) | 98.5316% (6 runs) | fresh 98.5316% (5 runs); market creator: 98.5316% | 98.5316% | 5 of 5 sold, 98.591% back in all | 72/72 | refused (NotPipeline); refused (AccountNotSigner) | none found |

## Strategy `EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b`

Version sha256 `997f1597c8fb6897ff7614f69288235c6728138da83739b72950048a83f0cdc4`, deployed in slot 520494490, upgrade authority `DEwdbWGmGf6vdtRMkBXez2zJ71JbAaJ1DdD1s3bN8tYn`.
Instructions beyond Pipeline's own: ClaimTax, InitializeConfig, Launch, SweepProtocolFees, UpdateConfig.
2 markets. `pipeline-check` result: 2 pass.

- 2 market(s) trades: 51Yanguq, AZ5m8DNB

| Market | Pair | pipeline-check | Round trip by size | Hold then sell | Arrive later | Clock at launch | Wallets | Transferred | Queue of 5 | Quotes = swaps | Direct call | Token authorities acting |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `51Yanguq` | 1>0>1 | pass (14p 0w 0f 0s) | 10000: 99.5012%; 1000000: 99.503%; 10000000: 99.5135%; 100000000: 99.5839%; 1000000000: 99.7086%; 10000000000: 99.7457% | 99.5135% (9 runs) | 99.5135% (8 runs) | at creation: 0.995%; 10 seconds after: 11.9404%; 1 minute after: 66.6716%; 10 minutes after: 99.5135%; 1 hour after: 99.5135% | fresh 99.5135% (5 runs); market creator: 99.5135%; upgrade authority: 99.5135% | 99.5135% | 5 of 5 sold, 99.551% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | none found |
| `AZ5m8DNB` | 1>0>1 | pass (14p 0w 0f 0s) | 10000: 99.5012%; 1000000: 99.5029%; 10000000: 99.5123%; 100000000: 99.5775%; 1000000000: 99.7043%; 10000000000: 99.7451% | 99.5123% (9 runs) | 99.5123% (8 runs) | at creation: 0.995%; 10 seconds after: 11.9404%; 1 minute after: 66.671%; 10 minutes after: 99.5123%; 1 hour after: 99.5123% | fresh 99.5123% (5 runs); market creator: 99.5123%; upgrade authority: 99.5123% | 99.5123% | 5 of 5 sold, 99.5465% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | none found |

## Strategy `yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx`

Version sha256 `f43d1f5df210c1d7bd7cfa9c13d08731f900b8a2acfd3fb36838c0e17ad3954c`, deployed in slot 520151682, upgrade authority `2yJJsmhvs2SBsKVtiKCG4wBJNoTH67aRNMhSwkupvUHZ`.
Instructions beyond Pipeline's own: Deposit.
23 markets. `pipeline-check` result: 2 fail, 21 pass.

- 2 market(s) cannot read state: AccountDidNotDeserialize (3003): 9XkNKSd8, AiZuQxcM
- 21 market(s) trades: 2EFM4BPq, 2uQ3SAT9, 35H28Sve, 4ZUW28pa, 4dauWRvL, 55tYAYQM, 5A7chnyq, 5aN7E664, 6KTPrEwW, 75U1k5M1, 8NTHjdgA, 8aqcXPo5, 8oonupU1, 9c5yEa85, A3hdhxwp, BMDWVHfU, DGDH8UA1, FmekUjjJ, FqGQj6aM, GTCx1zdQ, LCHsnkMf

| Market | Pair | pipeline-check | Round trip by size | Hold then sell | Arrive later | Clock at launch | Wallets | Transferred | Queue of 5 | Quotes = swaps | Direct call | Token authorities acting |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `2EFM4BPq` | 1>0>1 | pass (14p 0w 0f 0s) | 10000: 98.9027%; 1000000: 98.9421%; 10000000: 99.1685%; 100000000: 99.5974%; 1000000000: 99.7323%; 10000000000: 99.7488% | 99.1685% (9 runs) | 99.1685% (8 runs) | 99.1685% (6 runs) | fresh 99.1685% (5 runs); market creator: 99.1685%; upgrade authority: 99.1685% | 99.1685% | 5 of 5 sold, 99.4114% back in all | 76/76 | refused (NotPipeline); refused (AccountNotSigner) | none found |
| `2uQ3SAT9` | 1>0>1 | pass (14p 0w 0f 0s) | 10000: 98.9027%; 1000000: 98.9097%; 10000000: 98.9439%; 100000000: 99.177%; 1000000000: 99.6031%; 10000000000: 99.7331% | 98.9439% (9 runs) | 98.9439% (8 runs) | 98.9439% (6 runs) | fresh 98.9439% (5 runs); market creator: 98.9439%; upgrade authority: 98.9439% | 98.9439% | 5 of 5 sold, 99.0256% back in all | 76/76 | refused (NotPipeline); refused (AccountNotSigner) | none found |
| `35H28Sve` | 0>1>0 | pass (14p 0w 0f 0s) | 100001: 98.9038%; 10000100: 98.9058%; 100001000: 98.9066%; 1000010000: 98.914%; 5000050000: 98.9457% | 98.9066% (9 runs) | 98.9066% (8 runs) | 98.9066% (5 runs) | fresh 98.9066% (5 runs); market creator: 98.9066% | 98.9066% | 5 of 5 sold, 98.9087% back in all | 72/72 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 99.0045% of the other vault; mint authority of mint 1: mints and sells, takes 99.0045% of the other vault |
| `4ZUW28pa` | 0>1>0 | pass (14p 0w 0f 0s) | 100001: 98.9038%; 10000100: 98.9058%; 100001000: 98.9066%; 1000010000: 98.914%; 5000050000: 98.9457% | 98.9066% (9 runs) | 98.9066% (8 runs) | 98.9066% (6 runs) | fresh 98.9066% (5 runs); market creator: 98.9066% | 98.9066% | 5 of 5 sold, 98.9087% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 99.0045% of the other vault; mint authority of mint 1: mints and sells, takes 99.0045% of the other vault |
| `4dauWRvL` | 0>1>0 | pass (14p 0w 0f 0s) | 100001: 98.9038%; 10000100: 98.9058%; 100001000: 98.9066%; 1000010000: 98.914%; 5000050000: 98.9457% | 98.9066% (9 runs) | 98.9066% (8 runs) | 98.9066% (5 runs) | fresh 98.9066% (5 runs); market creator: 98.9066% | 98.9066% | 5 of 5 sold, 98.9087% back in all | 72/72 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 99.0045% of the other vault; mint authority of mint 1: mints and sells, takes 99.0045% of the other vault |
| `55tYAYQM` | 0>1>0 | pass (14p 0w 0f 0s) | 100001: 98.9038%; 10000100: 98.9058%; 100001000: 98.9066%; 1000010000: 98.914%; 5000050000: 98.9457% | 98.9066% (9 runs) | 98.9066% (8 runs) | 98.9066% (5 runs) | fresh 98.9066% (5 runs); market creator: 98.9066% | 98.9066% | 5 of 5 sold, 98.9087% back in all | 72/72 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 99.0045% of the other vault; mint authority of mint 1: mints and sells, takes 99.0045% of the other vault |
| `5A7chnyq` | 1>0>1 | pass (14p 0w 0f 0s) | 10000: 96.9277%; 1000000: 96.9462%; 10000000: 97.023%; 100000000: 97.6089%; 1000000000: 99.0703%; 10000000000: 99.6637% | 97.023% (9 runs) | 97.023% (8 runs) | 97.023% (6 runs) | fresh 97.023% (5 runs); market creator: 97.023%; upgrade authority: 97.023%; mint authority of mint 0: 97.023% | 96.082% | 5 of 5 sold, 97.2885% back in all | 80/80 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 98.9945% of the other vault; transfer fee authority of mint 0: sets the fee to 100%, then a round trip gives the buy took the money and delivered nothing |
| `5aN7E664` | 0>1>0 | pass (14p 0w 0f 0s) | 100001: 98.9038%; 10000100: 98.9058%; 100001000: 98.9066%; 1000010000: 98.914%; 5000050000: 98.9457% | 98.9066% (9 runs) | 98.9066% (8 runs) | 98.9066% (6 runs) | fresh 98.9066% (5 runs); market creator: 98.9066% | 98.9066% | 5 of 5 sold, 98.9087% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 99.0045% of the other vault; mint authority of mint 1: mints and sells, takes 99.0045% of the other vault |
| `6KTPrEwW` | 0>1>0 | pass (14p 0w 0f 0s) | 100001: 98.9038%; 10000100: 98.9058%; 100001000: 98.9066%; 1000010000: 98.914%; 5000050000: 98.9457% | 98.9066% (9 runs) | 98.9066% (8 runs) | 98.9066% (5 runs) | fresh 98.9066% (5 runs); market creator: 98.9066% | 98.9066% | 5 of 5 sold, 98.9087% back in all | 72/72 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 99.0045% of the other vault; mint authority of mint 1: mints and sells, takes 99.0045% of the other vault |
| `75U1k5M1` | 1>0>1 | pass (14p 0w 0f 0s) | 10000: 98.9027%; 1000000: 98.9097%; 10000000: 98.9439%; 100000000: 99.177%; 1000000000: 99.6031%; 10000000000: 99.7331% | 98.9439% (9 runs) | 98.9439% (8 runs) | 98.9439% (6 runs) | fresh 98.9439% (5 runs); market creator: 98.9439%; upgrade authority: 98.9439% | 98.9439% | 5 of 5 sold, 99.0256% back in all | 76/76 | refused (NotPipeline); refused (AccountNotSigner) | none found |
| `8NTHjdgA` | 0>1>0 | pass (14p 0w 0f 0s) | 100001: 98.9038%; 10000100: 98.9058%; 100001000: 98.9066%; 1000010000: 98.914%; 5000050000: 98.9457% | 98.9066% (9 runs) | 98.9066% (8 runs) | 98.9066% (6 runs) | fresh 98.9066% (5 runs); market creator: 98.9066%; upgrade authority: 98.9066% | 98.9066% | 5 of 5 sold, 98.9087% back in all | 76/76 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 99.0045% of the other vault; mint authority of mint 1: mints and sells, takes 99.0045% of the other vault |
| `8aqcXPo5` | 0>1>0 | pass (14p 0w 0f 0s) | 100001: 98.9038%; 10000100: 98.9058%; 100001000: 98.9066%; 1000010000: 98.914%; 5000050000: 98.9457% | 98.9066% (9 runs) | 98.9066% (8 runs) | 98.9066% (5 runs) | fresh 98.9066% (5 runs); market creator: 98.9066%; upgrade authority: 98.9066% | 98.9066% | 5 of 5 sold, 98.9087% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 99.0045% of the other vault; mint authority of mint 1: mints and sells, takes 99.0045% of the other vault |
| `8oonupU1` | 1>0>1 | pass (14p 0w 0f 0s) | 10000: 98.9027%; 1000000: 98.9097%; 10000000: 98.9439%; 100000000: 99.177%; 1000000000: 99.6031%; 10000000000: 99.7331% | 98.9439% (9 runs) | 98.9439% (8 runs) | 98.9439% (6 runs) | fresh 98.9439% (5 runs); market creator: 98.9439%; upgrade authority: 98.9439% | 98.9439% | 5 of 5 sold, 99.0256% back in all | 76/76 | refused (NotPipeline); refused (AccountNotSigner) | none found |
| `9c5yEa85` | 0>1>0 | pass (14p 0w 0f 0s) | 100001: 98.9038%; 10000100: 98.9058%; 100001000: 98.9066%; 1000010000: 98.914%; 5000050000: 98.9457% | 98.9066% (9 runs) | 98.9066% (8 runs) | 98.9066% (5 runs) | fresh 98.9066% (5 runs); market creator: 98.9066%; upgrade authority: 98.9066% | 98.9066% | 5 of 5 sold, 98.9087% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 99.0045% of the other vault; mint authority of mint 1: mints and sells, takes 99.0045% of the other vault |
| `A3hdhxwp` | 0>1>0 | pass (14p 0w 0f 0s) | 100001: 98.9038%; 10000100: 98.9058%; 100001000: 98.9066%; 1000010000: 98.914%; 5000050000: 98.9457% | 98.9066% (9 runs) | 98.9066% (8 runs) | 98.9066% (6 runs) | fresh 98.9066% (5 runs); market creator: 98.9066%; upgrade authority: 98.9066% | 98.9066% | 5 of 5 sold, 98.9087% back in all | 76/76 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 99.0045% of the other vault; mint authority of mint 1: mints and sells, takes 99.0045% of the other vault |
| `BMDWVHfU` | 0>1>0 | pass (14p 0w 0f 0s) | 100001: 98.9038%; 10000100: 98.9058%; 100001000: 98.9066%; 1000010000: 98.914%; 5000050000: 98.9457% | 98.9066% (9 runs) | 98.9066% (8 runs) | 98.9066% (5 runs) | fresh 98.9066% (5 runs); market creator: 98.9066%; upgrade authority: 98.9066% | 98.9066% | 5 of 5 sold, 98.9087% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 99.0045% of the other vault; mint authority of mint 1: mints and sells, takes 99.0045% of the other vault |
| `DGDH8UA1` | 0>1>0 | pass (14p 0w 0f 0s) | 100001: 98.9038%; 10000100: 98.9058%; 100001000: 98.9066%; 1000010000: 98.914%; 5000050000: 98.9457% | 98.9066% (9 runs) | 98.9066% (8 runs) | 98.9066% (5 runs) | fresh 98.9066% (5 runs); market creator: 98.9066% | 98.9066% | 5 of 5 sold, 98.9087% back in all | 72/72 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 99.0045% of the other vault; mint authority of mint 1: mints and sells, takes 99.0045% of the other vault |
| `FmekUjjJ` | 0>1>0 | pass (14p 0w 0f 0s) | 100001: 98.9038%; 10000100: 98.9058%; 100001000: 98.9066%; 1000010000: 98.914%; 5000050000: 98.9457% | 98.9066% (9 runs) | 98.9066% (8 runs) | 98.9066% (5 runs) | fresh 98.9066% (5 runs); market creator: 98.9066%; upgrade authority: 98.9066% | 98.9066% | 5 of 5 sold, 98.9087% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 99.0045% of the other vault; mint authority of mint 1: mints and sells, takes 99.0045% of the other vault |
| `FqGQj6aM` | 0>1>0 | pass (14p 0w 0f 0s) | 100001: 98.9038%; 10000100: 98.9058%; 100001000: 98.9066%; 1000010000: 98.914%; 5000050000: 98.9457% | 98.9066% (9 runs) | 98.9066% (8 runs) | 98.9066% (6 runs) | fresh 98.9066% (5 runs); market creator: 98.9066% | 98.9066% | 5 of 5 sold, 98.9087% back in all | 74/74 | refused (NotPipeline); refused (AccountNotSigner) | mint authority of mint 0: mints and sells, takes 99.0045% of the other vault; mint authority of mint 1: mints and sells, takes 99.0045% of the other vault |
| `GTCx1zdQ` | 1>0>1 | pass (14p 0w 0f 0s) | 10000: 98.9027%; 1000000: 98.9195%; 10000000: 99.0257%; 100000000: 99.4324%; 1000000000: 99.7025%; 10000000000: 99.7455% | 99.0257% (9 runs) | 99.0257% (8 runs) | 99.0257% (6 runs) | fresh 99.0257% (5 runs); market creator: 99.0257%; upgrade authority: 99.0257% | 99.0257% | 5 of 5 sold, 99.2085% back in all | 76/76 | refused (NotPipeline); refused (AccountNotSigner) | none found |
| `LCHsnkMf` | 1>0>1 | pass (14p 0w 0f 0s) | 10000: 98.9027%; 1000000: 98.9097%; 10000000: 98.9439%; 100000000: 99.177%; 1000000000: 99.6031%; 10000000000: 99.7331% | 98.9439% (9 runs) | 98.9439% (8 runs) | 98.9439% (6 runs) | fresh 98.9439% (5 runs); market creator: 98.9439%; upgrade authority: 98.9439% | 98.9439% | 5 of 5 sold, 99.0256% back in all | 76/76 | refused (NotPipeline); refused (AccountNotSigner) | none found |

