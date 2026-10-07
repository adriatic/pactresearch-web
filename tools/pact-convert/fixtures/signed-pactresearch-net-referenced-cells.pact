{
  "version": 1,
  "payload": {
    "version": 1,
    "exportedAt": 1779832800000,
    "notebook": {
      "name": "Fixture referenced cells",
      "systemPrompt": null
    },
    "discussions": [
      {
        "id": "d1",
        "name": "Synthetic 1",
        "createdAt": 1779829260000,
        "totalTimeMs": 1000
      },
      {
        "id": "d2",
        "name": "Synthetic 2",
        "createdAt": 1779829320000,
        "totalTimeMs": 2000
      },
      {
        "id": "d3",
        "name": "Synthetic 3",
        "createdAt": 1779829380000,
        "totalTimeMs": 3000
      }
    ],
    "cells": [
      {
        "id": "c1",
        "discussionId": "d1",
        "parentId": null,
        "promptText": "Synthetic question one.\nWith a second line.",
        "response": "Synthetic answer one.\n\n- point",
        "model": "claude",
        "cellType": "user",
        "createdAt": 1779829265000
      },
      {
        "id": "c2",
        "discussionId": "d2",
        "parentId": null,
        "promptText": "[Referenced Cell]\nPrompt: Synthetic question one.\nWith a second line.\nResponse: Synthetic answer one.\n\n- point\nSynthetic follow-up two?",
        "response": "Synthetic answer two, first run.",
        "model": "claude",
        "cellType": "user",
        "createdAt": 1779829325000
      },
      {
        "id": "c3",
        "discussionId": "d2",
        "parentId": null,
        "promptText": "[Referenced Cell]\nPrompt: Synthetic question one.\nWith a second line.\nResponse: Synthetic answer one.\n\n- point\nSynthetic follow-up two?",
        "response": "Synthetic answer two, second run.",
        "model": "claude",
        "cellType": "user",
        "createdAt": 1779829355000
      },
      {
        "id": "c4",
        "discussionId": "d3",
        "parentId": null,
        "promptText": "[Referenced Cell]\nPrompt: [Referenced Cell]\nPrompt: Synthetic question one.\nWith a second line.\nResponse: Synthetic answer one.\n\n- point\nSynthetic follow-up two?\nResponse: Synthetic answer two, second run.\nSynthetic follow-up three?",
        "response": "Synthetic answer three.",
        "model": "claude",
        "cellType": "user",
        "createdAt": 1779829385000
      }
    ]
  },
  "signature": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  "signedAt": 1779832800000,
  "signer": "pactresearch.net"
}
