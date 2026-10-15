import anthropic

client = anthropic.Anthropic()


def summarize(ticket):
    """Summarize a support ticket for the account team."""
    contact_email = "jane.roe@example.org"
    reply = client.messages.create(
        model="claude-3-5-haiku-latest",
        max_tokens=300,
        messages=[{"role": "user", "content": f"Summarize the ticket from {contact_email}: {ticket}"}],
    )
    return reply.content[0].text
