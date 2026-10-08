import anthropic

client = anthropic.Anthropic()


def triage_symptoms(ssn: str, symptoms: str, insurance_id: str):
    msg = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=512,
        messages=[{"role": "user", "content": f"Triage these symptoms: {symptoms} for member {insurance_id}"}],
    )
    return msg.content[0].text
